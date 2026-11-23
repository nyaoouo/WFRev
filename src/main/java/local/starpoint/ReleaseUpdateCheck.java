package local.starpoint;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONException;
import org.json.JSONObject;

final class ReleaseUpdateCheck {
    private static final int CHECK_TIMEOUT_MS = 8000;
    private static final int IO_TIMEOUT_MS = 3000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Activity foregroundGame;
    private GitHubReleaseInfo.Update pending;
    private boolean started;
    private boolean shown;

    void onGameResumed(Activity activity) {
        foregroundGame = activity;
        showIfPending();
        if (started) return;
        started = true;
        Context context = activity.getApplicationContext();
        Thread worker = new Thread(() -> check(context), "starpoint-release-check");
        worker.setDaemon(true);
        worker.start();
    }

    void onGamePaused(Activity activity) {
        if (foregroundGame == activity) foregroundGame = null;
    }

    private void check(Context context) {
        long deadline = SystemClock.elapsedRealtime() + CHECK_TIMEOUT_MS;
        try (InputStream config = context.getAssets().open("starpoint/" + GitHubReleaseInfo.ASSET_NAME)) {
            JSONObject current = new JSONObject(readText(config, GitHubReleaseInfo.MAX_METADATA_BYTES, deadline));
            GitHubReleaseInfo.Update update = GitHubReleaseInfo.check(current,
                    (uri, limit) -> new JSONObject(fetch(uri, limit, deadline)));
            if (update == null || SystemClock.elapsedRealtime() >= deadline) return;
            main.post(() -> {
                pending = update;
                showIfPending();
            });
        } catch (IOException | JSONException ignored) {
            // A local APK has no release configuration. Network failures also leave gameplay alone.
        }
    }

    private void showIfPending() {
        Activity game = foregroundGame;
        GitHubReleaseInfo.Update update = pending;
        if (shown || update == null || game == null || game.isFinishing() || game.isDestroyed()) return;
        shown = true;
        pending = null;
        SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd HH:mm 'UTC'", Locale.ROOT);
        date.setTimeZone(TimeZone.getTimeZone("UTC"));
        new AlertDialog.Builder(game)
                .setTitle("有可用更新")
                .setMessage("GitHub 已发布更新。构建于 " + date.format(new Date(update.timestamp)) + "。")
                .setNegativeButton("稍后", null)
                .setPositiveButton("查看发布页", (dialog, button) -> openRelease(game, update))
                .show();
    }

    private static void openRelease(Activity game, GitHubReleaseInfo.Update update) {
        try {
            game.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(update.releasePage.toString())));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(game, "没有可打开发布页的浏览器。", Toast.LENGTH_SHORT).show();
        }
    }

    private static String fetch(URI uri, int limit, long deadline) throws IOException {
        for (int redirect = 0; redirect <= 3; redirect++) {
            if (!isDownloadHost(uri)) throw new IOException("Unexpected GitHub endpoint");
            HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(timeout(deadline));
                connection.setReadTimeout(timeout(deadline));
                connection.setRequestProperty("User-Agent", "StarPoint-CN-Release-Check");
                connection.setRequestProperty("Accept", "api.github.com".equals(uri.getHost())
                        ? "application/vnd.github+json" : "application/json");
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String next = connection.getHeaderField("Location");
                    if (next == null) throw new IOException("GitHub redirect has no location");
                    try {
                        uri = uri.resolve(next);
                    } catch (IllegalArgumentException error) {
                        throw new IOException("Invalid GitHub redirect", error);
                    }
                    continue;
                }
                if (status != 200 || connection.getContentLengthLong() > limit) {
                    throw new IOException("GitHub release information unavailable");
                }
                try (InputStream input = connection.getInputStream()) {
                    return readText(input, limit, deadline);
                }
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Too many GitHub redirects");
    }

    private static boolean isDownloadHost(URI uri) {
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null
                || uri.getPort() != -1 || uri.getUserInfo() != null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return "api.github.com".equals(host) || "github.com".equals(host)
                || host.endsWith(".githubusercontent.com");
    }

    private static int timeout(long deadline) throws IOException {
        long remaining = deadline - SystemClock.elapsedRealtime();
        if (remaining <= 0) throw new IOException("Release check timed out");
        return (int) Math.min(IO_TIMEOUT_MS, remaining);
    }

    private static String readText(InputStream input, int limit, long deadline) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            timeout(deadline);
            if (output.size() + count > limit) throw new IOException("Release metadata exceeds limit");
            output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
