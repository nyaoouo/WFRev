package local.starpoint;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.Process;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.util.Map;

public final class OfflineServer extends Service {
    private static final String CHANNEL_ID = "starpoint-local-server";
    private static final int NOTIFICATION_ID = 8001;
    private Thread worker;
    private File activeDirectory;
    private volatile String startupRequest;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // The AIR activity and the backend run in separate processes.
        // Keep serving localhost even while the game or this service is not visible.
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, "本地国服服务", NotificationManager.IMPORTANCE_LOW));
        Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:8001/admin/"))
                .addCategory(Intent.CATEGORY_BROWSABLE);
        PendingIntent openAdmin = PendingIntent.getActivity(this, 0, browser,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        startForeground(NOTIFICATION_ID, new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("世界弹射物语")
                .setContentText("本地国服服务运行中，点此打开管理后台")
                .setContentIntent(openAdmin)
                .setOngoing(true)
                .build());
        String location = intent == null ? CdnDirectory.savedLocation(this)
                : intent.getStringExtra(BackendStartup.CDN_DIRECTORY);
        String request = intent == null ? null : intent.getStringExtra(BackendStartup.REQUEST);
        if (location == null) {
            BackendStartup.report(getFilesDir(), request, "未选择 CDN 目录。");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        File selected = new File(location);
        if (worker != null && !selected.equals(activeDirectory)) {
            BackendStartup.report(getFilesDir(), request, "服务正在使用另一个 CDN 目录。请关闭并重新打开游戏。");
            return START_STICKY;
        }
        startupRequest = request;
        if (worker == null) {
            if (intent == null) Log.i("StarPoint", "Android restarted the local backend service");
            activeDirectory = selected;
            worker = new Thread(() -> startBackend(selected), "starpoint-node");
            worker.start();
        } else {
            BackendStartup.report(getFilesDir(), request, "");
        }
        return START_STICKY;
    }

    private void startBackend(File cdn) {
        File root = getFilesDir();
        File runtime = new File(root, "offline-runtime");
        File libraries = new File(getApplicationInfo().nativeLibraryDir);
        String systemAbi = Build.SUPPORTED_ABIS[0];
        File x64Executable = new File(libraries, "libstarpoint_exec_x64.so");
        boolean useX64Executable = "x86_64".equals(systemAbi) && x64Executable.isFile();
        Map<String, String> settings = new java.util.HashMap<>();
        settings.put("NODE_PATH", new File(runtime, "node_modules").getPath());
        String sqlite = useX64Executable ? "libstarpoint_sqlite_x64.so" : "libstarpoint_sqlite.so";
        settings.put("BETTER_SQLITE3_NATIVE_BINDING", new File(libraries, sqlite).getPath());
        settings.put("DATA_DIR", new File(root, "offline-save").getPath());
        settings.put("CDN_DIR", cdn.getPath());
        settings.put("EMBEDDED_RUNTIME", "1");
        settings.put("ASSET_MODE", "local");
        settings.put("CN_LISTEN_HOST", "127.0.0.1");
        settings.put("SESSION_HOST", "127.0.0.1");
        settings.put("SESSION_PUBLIC_HOST", "127.0.0.1");
        settings.put("CDN_BASE_URL", "http://127.0.0.1:8001/patch/cn");
        File log = new File(root, BackendStartup.LOG_NAME);
        String entry = new File(runtime, "start.cjs").getPath();
        try {
            settings.put("COMIC_DIR", ComicDirectory.prepare(this).getPath());
            try (PrintStream startup = new PrintStream(new FileOutputStream(log), true, "UTF-8")) {
                startup.println("后端：直接读取 CDN " + CdnDirectory.validate(cdn));
                startup.println("后端：加载 " + systemAbi + " 运行时");
            }
            BackendStartup.report(root, startupRequest, "");
            Log.i("StarPoint", "Backend system ABI: " + systemAbi
                    + (useX64Executable ? " (native executable)" : " (JNI)"));
            int exit;
            if (useX64Executable) {
                ProcessBuilder builder = new ProcessBuilder(x64Executable.getPath(), entry);
                builder.environment().putAll(settings);
                builder.environment().put("LD_LIBRARY_PATH", libraries.getPath());
                builder.redirectErrorStream(true);
                builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
                exit = builder.start().waitFor();
            } else {
                try (FileOutputStream output = new FileOutputStream(log, true)) {
                    android.system.Os.dup2(output.getFD(), 1);
                    android.system.Os.dup2(output.getFD(), 2);
                    for (Map.Entry<String, String> setting : settings.entrySet()) {
                        android.system.Os.setenv(setting.getKey(), setting.getValue(), true);
                    }
                    System.loadLibrary("node");
                    System.loadLibrary("starpoint_bridge");
                    exit = runNode(entry);
                }
            }
            throw new IOException("后端进程退出，退出码 " + exit + "。");
        } catch (Exception | LinkageError error) {
            try (PrintStream diagnostics = new PrintStream(new FileOutputStream(log, true), true, "UTF-8")) {
                error.printStackTrace(diagnostics);
            } catch (IOException ignored) {
                Log.e("StarPoint", "Could not append backend error", ignored);
            }
            BackendStartup.report(root, startupRequest, error.toString());
            Log.e("StarPoint", "Offline backend did not start", error);
        } finally {
            // A known exit already has diagnostics. Retrying it as a sticky restart can loop.
            stopSelf();
            Process.killProcess(Process.myPid());
        }
    }

    private static native int runNode(String entry);
}
