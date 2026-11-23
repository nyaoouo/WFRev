package local.starpoint;

import android.app.ActivityManager;
import android.content.Context;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;

final class BackendStartup {
    static final String REQUEST = "startup-request";
    static final String CDN_DIRECTORY = "cdn-directory";
    static final String RESUME_GAME = "resume-game";
    static final String STOP = "local.starpoint.STOP_LOCAL_BACKEND";
    static final String LOG_NAME = "backend.log";
    private static final String REPORT_NAME = "backend-startup.txt";
    private static final int MAX_LOG_BYTES = 12 * 1024;

    static void report(File directory, String request, String error) {
        if (request == null) return;
        Path staged = null;
        try {
            Path root = directory.toPath();
            staged = Files.createTempFile(root, "backend-status-", ".tmp");
            Files.write(staged, (request + "\n" + error).getBytes(StandardCharsets.UTF_8));
            Files.move(staged, root.resolve(REPORT_NAME),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException failure) {
            Log.e("StarPoint", "Could not report backend status", failure);
        } finally {
            if (staged != null) {
                try {
                    Files.deleteIfExists(staged);
                } catch (IOException failure) {
                    Log.w("StarPoint", "Could not remove staged startup status", failure);
                }
            }
        }
    }

    // Null means the service has not accepted this request; an empty value means it has.
    static String readReport(File directory, String request) throws IOException {
        File report = new File(directory, REPORT_NAME);
        if (!report.isFile()) return null;
        String text = new String(Files.readAllBytes(report.toPath()), StandardCharsets.UTF_8);
        String prefix = request + "\n";
        return text.startsWith(prefix) ? text.substring(prefix.length()) : null;
    }

    static String tail(File log) throws IOException {
        if (!log.isFile()) return "";
        try (RandomAccessFile input = new RandomAccessFile(log, "r")) {
            long size = input.length();
            byte[] bytes = new byte[(int) Math.min(size, MAX_LOG_BYTES)];
            input.seek(size - bytes.length);
            int count = input.read(bytes);
            if (count < 0) return "";
            String text = new String(bytes, 0, count, StandardCharsets.UTF_8);
            int firstLine = text.indexOf('\n');
            return size > bytes.length && firstLine >= 0 ? text.substring(firstLine + 1) : text;
        }
    }

    static boolean isReady() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:8001/healthz")
                    .openConnection(Proxy.NO_PROXY);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(400);
            connection.setReadTimeout(500);
            return connection.getResponseCode() == 200;
        } catch (IOException error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static boolean hasServiceProcess(Context context) {
        ActivityManager manager = context.getSystemService(ActivityManager.class);
        List<ActivityManager.RunningAppProcessInfo> processes = manager == null ? null : manager.getRunningAppProcesses();
        if (processes == null) return false;
        String name = context.getPackageName() + ":starpoint";
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (name.equals(process.processName)) return true;
        }
        return false;
    }
}
