package local.starpoint;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class OfflineEntry extends Activity {
    private static final int PICK_CDN = 1;
    private static final int STORAGE_ACCESS = 2;
    private static final int PICK_COMIC = 3;
    private static final int COMIC_STORAGE_ACCESS = 4;
    private static final String COMIC_SETTINGS = "local.starpoint.COMIC_SETTINGS";
    private static final String MULTIPLAYER_SETTINGS = "local.starpoint.MULTIPLAYER_SETTINGS";
    private static final String COMIC_SETUP_DONE = "comic-setup-done";
    private static final String COMIC_SHORTCUT = "starpoint-comic-settings";
    private static final String MULTIPLAYER_SHORTCUT = "starpoint-multiplayer-settings";
    private static final long MAX_RUNTIME_BYTES = 256L * 1024 * 1024;
    private static final long START_TIMEOUT_MS = 240_000L;
    private static final String CDN_DOWNLOAD =
            "https://github.com/dennis96292/.cdn/releases/tag/cdn-1.4.54";
    private static final String CDN_INSTRUCTIONS =
            "下载 CDN 1.4.54 的 .00–.05 六个分卷，按顺序合并成 cn-cdn.tar 后解压。"
            + "如果已有完整 CDN ZIP，直接解压即可。请选择 cn 文件夹或它的上一级。";
    private TextView status;
    private TextView instructions;
    private ProgressBar progress;
    private ScrollView logPanel;
    private TextView logText;
    private Button choose;
    private Button download;
    private Button action;
    private Button comic;
    private Button clearComic;
    private Button comicAccess;
    private Button multiplayer;
    private boolean showingComicSettings;
    private File pendingComic;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (MULTIPLAYER_SETTINGS.equals(getIntent().getAction())) {
            openMultiplayerSettings();
            finish();
            return;
        }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        status = new TextView(this);
        status.setTextSize(18);
        layout.addView(status);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        layout.addView(progress);
        instructions = new TextView(this);
        layout.addView(instructions);
        choose = new Button(this);
        choose.setText("选择 CDN 文件夹");
        choose.setOnClickListener(view -> pickDirectory(PICK_CDN));
        layout.addView(choose);
        download = new Button(this);
        download.setText("前往 GitHub 下载 CDN 1.4.54");
        download.setOnClickListener(view -> openDownloadPage());
        layout.addView(download);
        comic = new Button(this);
        layout.addView(comic);
        clearComic = new Button(this);
        clearComic.setText("清除漫画目录设置");
        clearComic.setOnClickListener(view -> {
            pendingComic = null;
            try {
                ComicDirectory.clear(this);
                showComicSettings(null);
            } catch (IOException error) {
                showComicSettings(error.getMessage());
            }
        });
        layout.addView(clearComic);
        comicAccess = new Button(this);
        comicAccess.setText("开启文件访问");
        comicAccess.setOnClickListener(view -> requestStorageAccess(COMIC_STORAGE_ACCESS));
        layout.addView(comicAccess);
        multiplayer = new Button(this);
        multiplayer.setText("联机设置");
        multiplayer.setOnClickListener(view -> openMultiplayerSettings());
        layout.addView(multiplayer);
        action = new Button(this);
        layout.addView(action);
        logPanel = new ScrollView(this);
        logText = new TextView(this);
        logText.setTextSize(13);
        logText.setTypeface(Typeface.MONOSPACE);
        logText.setTextIsSelectable(true);
        logPanel.addView(logText);
        layout.addView(logPanel, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        logPanel.setVisibility(View.GONE);
        installSettingsShortcuts();
        if (state != null) {
            String pending = state.getString("pending-comic");
            pendingComic = pending == null ? null : new File(pending);
        }
        if (COMIC_SETTINGS.equals(getIntent().getAction())
                || (state != null && state.getBoolean("showing-comic-settings"))) {
            showComicSettings(null);
        } else {
            startConfigured();
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("showing-comic-settings", showingComicSettings);
        if (pendingComic != null) state.putString("pending-comic", pendingComic.getPath());
    }

    private void openMultiplayerSettings() {
        startActivity(new Intent(this, MultiplayerSettings.class));
    }

    private void installSettingsShortcuts() {
        if (Build.VERSION.SDK_INT < 25) return;
        ShortcutManager manager = getSystemService(ShortcutManager.class);
        if (manager == null) return;
        try {
            List<ShortcutInfo> shortcuts = new ArrayList<>();
            List<ShortcutInfo> existing = manager.getDynamicShortcuts();
            addSettingsShortcut(shortcuts, existing, COMIC_SHORTCUT, COMIC_SETTINGS, "漫画设置");
            addSettingsShortcut(shortcuts, existing, MULTIPLAYER_SHORTCUT, MULTIPLAYER_SETTINGS, "联机设置");
            if (!shortcuts.isEmpty()) manager.addDynamicShortcuts(shortcuts);
        } catch (RuntimeException error) {
            android.util.Log.w("StarPoint", "Unable to publish settings shortcuts", error);
        }
    }

    private void addSettingsShortcut(List<ShortcutInfo> shortcuts, List<ShortcutInfo> existing,
            String id, String action, String label) {
        for (ShortcutInfo entry : existing) {
            if (id.equals(entry.getId())) return;
        }
        shortcuts.add(new ShortcutInfo.Builder(this, id)
                .setShortLabel(label)
                .setIntent(new Intent(this, OfflineEntry.class).setAction(action))
                .build());
    }

    private void pickDirectory(int request) {
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        picker.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(
                "com.android.externalstorage.documents", "primary:Download"));
        try {
            startActivityForResult(picker, request);
        } catch (ActivityNotFoundException error) {
            if (request == PICK_COMIC) showComicSettings("此设备没有可用的系统文件夹选择器。");
            else showSetup("此设备没有可用的系统文件夹选择器。");
        }
    }

    private void openDownloadPage() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(CDN_DOWNLOAD)));
        } catch (ActivityNotFoundException error) {
            showSetup("没有可打开下载页的浏览器。\n" + CDN_DOWNLOAD);
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == STORAGE_ACCESS) {
            startConfigured();
        } else if (request == COMIC_STORAGE_ACCESS && pendingComic != null) {
            setComicDirectory(pendingComic);
        } else if (request == PICK_COMIC && result == RESULT_OK && data != null && data.getData() != null) {
            try {
                setComicDirectory(CdnDirectory.sharedDirectoryFromTree(this, data.getData()));
            } catch (IOException | IllegalArgumentException error) {
                showComicSettings(error.getMessage());
            }
        } else if (request == PICK_CDN && result == RESULT_OK && data != null && data.getData() != null) {
            try {
                File parent = CdnDirectory.fromTree(this, data.getData());
                getSharedPreferences(CdnDirectory.PREFERENCES, MODE_PRIVATE).edit()
                        .putString(CdnDirectory.LOCATION, parent.getPath()).apply();
                startConfigured();
            } catch (IOException | IllegalArgumentException error) {
                showSetup(error.getMessage());
            }
        }
    }

    private void showSetup(String message) {
        showingComicSettings = false;
        status.setText(message);
        progress.setVisibility(View.GONE);
        instructions.setText(CDN_INSTRUCTIONS);
        instructions.setVisibility(View.VISIBLE);
        choose.setVisibility(View.VISIBLE);
        download.setVisibility(View.VISIBLE);
        comic.setVisibility(View.VISIBLE);
        comic.setText("漫画设置");
        comic.setOnClickListener(view -> showComicSettings(null));
        clearComic.setVisibility(View.GONE);
        comicAccess.setVisibility(View.GONE);
        multiplayer.setVisibility(View.VISIBLE);
        action.setVisibility(View.GONE);
    }

    private void showComicSettings(String message) {
        showingComicSettings = true;
        String current = null;
        try {
            current = ComicDirectory.currentSelection(this);
        } catch (IOException error) {
            message = error.getMessage();
        }
        String location = current == null ? "尚未选择" : current;
        status.setText("漫画目录（可选）\n" + location + (message == null ? "" : "\n" + message));
        instructions.setText("选择直接包含 0 或 1 的「漫画」文件夹。留空时，图片接口会显示黑色占位图。");
        instructions.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
        logPanel.setVisibility(View.GONE);
        choose.setVisibility(View.GONE);
        download.setVisibility(View.GONE);
        comic.setVisibility(View.VISIBLE);
        comic.setText("选择漫画目录");
        comic.setOnClickListener(view -> pickDirectory(PICK_COMIC));
        clearComic.setVisibility(current == null ? View.GONE : View.VISIBLE);
        comicAccess.setVisibility(pendingComic == null ? View.GONE : View.VISIBLE);
        multiplayer.setVisibility(View.VISIBLE);
        boolean shortcut = COMIC_SETTINGS.equals(getIntent().getAction());
        showAction(shortcut ? "关闭设置" : current == null ? "跳过并继续启动" : "继续启动", () -> {
            getSharedPreferences(CdnDirectory.PREFERENCES, MODE_PRIVATE).edit()
                    .putBoolean(COMIC_SETUP_DONE, true).apply();
            if (shortcut) finish();
            else startConfigured();
        });
    }

    private void setComicDirectory(File folder) {
        pendingComic = null;
        try {
            ComicDirectory.select(this, folder);
            showComicSettings("已保存漫画目录。");
        } catch (IOException error) {
            if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager() && folder.list() == null) {
                pendingComic = folder;
            }
            showComicSettings(error.getMessage());
        }
    }

    private void showAction(String label, Runnable handler) {
        action.setText(label);
        action.setVisibility(View.VISIBLE);
        action.setOnClickListener(view -> handler.run());
    }

    private void requestStorageAccess(int request) {
        try {
            Intent settings = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivityForResult(settings, request);
        } catch (ActivityNotFoundException error) {
            status.setText("请在系统设置中为《世界弹射物语》开启「所有文件访问」，然后重新打开游戏。");
        }
    }

    private void startConfigured() {
        String path = CdnDirectory.savedLocation(this);
        if (path == null) {
            showSetup("请选择国服 CDN 文件夹。");
            return;
        }
        File cdn;
        try {
            cdn = CdnDirectory.validate(new File(path));
        } catch (IOException error) {
            if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
                showSetup("Android 需要「所有文件访问」才能让本地后端按路径读取所选 CDN。");
                showAction("开启文件访问", () -> requestStorageAccess(STORAGE_ACCESS));
            } else {
                showSetup(error.getMessage());
            }
            return;
        }
        if (!getIntent().getBooleanExtra(BackendStartup.RESUME_GAME, false)
                && !getSharedPreferences(CdnDirectory.PREFERENCES, MODE_PRIVATE)
                        .getBoolean(COMIC_SETUP_DONE, false)) {
            showComicSettings(null);
        } else {
            boot(cdn);
        }
    }

    private void boot(File cdn) {
        showingComicSettings = false;
        long started = SystemClock.elapsedRealtime();
        progress.setVisibility(View.VISIBLE);
        instructions.setVisibility(View.GONE);
        choose.setVisibility(View.GONE);
        download.setVisibility(View.GONE);
        comic.setVisibility(View.GONE);
        clearComic.setVisibility(View.GONE);
        comicAccess.setVisibility(View.GONE);
        multiplayer.setVisibility(View.GONE);
        action.setVisibility(View.GONE);
        updateStartup(started, getIntent().getBooleanExtra(BackendStartup.RESUME_GAME, false)
                ? "正在恢复本地国服服务…" : "正在准备后端运行文件…", "");
        new Thread(() -> {
            String request = UUID.randomUUID().toString();
            String recentLog = "";
            try {
                File runtime = new File(getFilesDir(), "offline-runtime");
                prepareRuntime(runtime, started);
                Intent service = new Intent(this, OfflineServer.class)
                        .putExtra(BackendStartup.REQUEST, request)
                        .putExtra(BackendStartup.CDN_DIRECTORY, cdn.getPath());
                startForegroundService(service);
                File log = new File(getFilesDir(), BackendStartup.LOG_NAME);
                long deadline = SystemClock.elapsedRealtime() + START_TIMEOUT_MS;
                while (SystemClock.elapsedRealtime() < deadline) {
                    String report = BackendStartup.readReport(getFilesDir(), request);
                    if (report != null) {
                        recentLog = BackendStartup.tail(log);
                        if (!report.isEmpty()) throw new IOException(report);
                        if (BackendStartup.isReady()) {
                            finishStartup(started, recentLog);
                            return;
                        }
                    }
                    String phase = recentLog.contains("后端：启动 HTTP 服务")
                            ? "正在启动本地 HTTP 服务…" : "正在校验 CDN 并同步游戏数据…";
                    updateStartup(started, phase, recentLog);
                    SystemClock.sleep(750);
                }
                throw new IOException("等待本地服务就绪超过 4 分钟。");
            } catch (Exception error) {
                String log = recentLog;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    showSetup("启动失败：" + error.getMessage());
                    renderLog(log);
                    showAction("重试", this::startConfigured);
                });
            }
        }, "starpoint-start").start();
    }

    private void updateStartup(long started, String phase, String log) {
        long seconds = (SystemClock.elapsedRealtime() - started) / 1000;
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            status.setText(phase + "\n已等待 " + seconds + " 秒");
            renderLog(log);
        });
    }

    private void renderLog(String log) {
        logPanel.setVisibility(log.isEmpty() ? View.GONE : View.VISIBLE);
        if (!log.contentEquals(logText.getText())) {
            logText.setText(log);
            logPanel.post(() -> logPanel.scrollTo(0, logText.getHeight()));
        }
    }

    private void prepareRuntime(File runtime, long started) throws IOException {
        if (!runtime.isDirectory()) {
            File stage = Files.createTempDirectory(getFilesDir().toPath(), "runtime-import-").toFile();
            try (InputStream input = getAssets().open("starpoint/runtime.zip")) {
                extractRuntime(input, stage, started);
                Files.move(stage.toPath(), runtime.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } finally {
                if (stage.exists()) removeTree(stage);
            }
        }
        for (String name : new String[]{"payment-catalog.cjs", "payment-page.cjs", "history-page.cjs",
                "local-history.cjs", "quota-admin.cjs", "local-payment.cjs", "local-encyclopedia.cjs",
                "team-content.cjs", "team-planner.cjs", "local-team-recommendations.cjs",
                "local-coop-companions.cjs", "local-coop-requests.cjs", "local-hub-endpoint.cjs", "start.cjs"}) {
            File staged = new File(runtime, name + ".new");
            try (InputStream script = getAssets().open("starpoint/" + name)) {
                Files.copy(script, staged.toPath(), StandardCopyOption.REPLACE_EXISTING);
                Files.move(staged.toPath(), new File(runtime, name).toPath(),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } finally {
                Files.deleteIfExists(staged.toPath());
            }
        }
    }

    private void finishStartup(long started, String recentLog) {
        File legacy = new File(getFilesDir(), "offline-cdn-1.4.54");
        if (legacy.exists()) {
            updateStartup(started, "正在清理旧版导入的 CDN 副本…", recentLog);
            try {
                removeTree(legacy);
                android.util.Log.i("StarPoint", "Removed legacy private CDN copy");
            } catch (IOException error) {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    progress.setVisibility(View.GONE);
                    status.setText("本地服务已就绪。旧 CDN 副本未能完全清理：" + error.getMessage());
                    showAction("进入游戏", this::openGame);
                });
                return;
            }
        }
        runOnUiThread(this::openGame);
    }

    private void openGame() {
        if (isFinishing() || isDestroyed()) return;
        if (!getIntent().getBooleanExtra(BackendStartup.RESUME_GAME, false)) {
            Intent game = new Intent();
            game.setClassName("com.leiting.wf", "com.leiting.sdk.activity.PrivacyActivity");
            startActivity(game);
        }
        finish();
    }

    @Override public void onBackPressed() {
        if (getIntent().getBooleanExtra(BackendStartup.RESUME_GAME, false)) {
            moveTaskToBack(true);
        }
        super.onBackPressed();
    }

    private void extractRuntime(InputStream input, File destination, long started) throws IOException {
        String root = destination.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(input)) {
            long written = 0;
            long lastUpdate = 0;
            int entries = 0;
            byte[] buffer = new byte[256 * 1024];
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; zip.closeEntry()) {
                if (++entries > 30000 || entry.getName().indexOf('\\') >= 0) throw new IOException("运行包目录无效");
                File output = new File(destination, entry.getName()).getCanonicalFile();
                if (!output.getPath().startsWith(root)) throw new IOException("运行包文件超出目标目录");
                if (entry.isDirectory()) {
                    Files.createDirectories(output.toPath());
                    continue;
                }
                Files.createDirectories(output.getParentFile().toPath());
                try (java.io.OutputStream file = Files.newOutputStream(output.toPath(),
                        java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)) {
                    for (int size; (size = zip.read(buffer)) != -1;) {
                        written += size;
                        if (written > MAX_RUNTIME_BYTES) throw new IOException("运行包解压超过大小限制");
                        file.write(buffer, 0, size);
                    }
                }
                if (SystemClock.elapsedRealtime() - lastUpdate >= 500) {
                    lastUpdate = SystemClock.elapsedRealtime();
                    updateStartup(started, "正在解包后端，已写入 " + (written / 1048576) + " MiB", "");
                }
            }
        }
    }

    private static void removeTree(File file) throws IOException {
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取 " + file.getName());
            for (File child : children) removeTree(child);
        }
        Files.delete(file.toPath());
    }
}
