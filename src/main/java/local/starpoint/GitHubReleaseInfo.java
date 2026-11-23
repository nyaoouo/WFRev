package local.starpoint;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class GitHubReleaseInfo {
    static final String ASSET_NAME = "starpoint-release.json";
    static final String APK_NAME = "WorldFlipper-CN-Offline.apk";
    static final int SCHEMA = 1;
    static final int MAX_RELEASE_BYTES = 512 * 1024;
    static final int MAX_METADATA_BYTES = 4096;

    interface JsonLoader {
        JSONObject load(URI uri, int byteLimit) throws IOException, JSONException;
    }

    static final class Update {
        final long timestamp;
        final URI releasePage;

        Update(long timestamp, URI releasePage) {
            this.timestamp = timestamp;
            this.releasePage = releasePage;
        }
    }

    static Update check(JSONObject current, JsonLoader loader) throws IOException, JSONException {
        String repository = current.optString("repository").toLowerCase(Locale.ROOT);
        long installed = timestamp(current);
        if (current.optInt("schema") != SCHEMA || installed <= 0 || !validRepository(repository)) return null;

        JSONObject release = loader.load(
                URI.create("https://api.github.com/repos/" + repository + "/releases/latest"), MAX_RELEASE_BYTES);
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return null;
        URI page = githubUri(release.optString("html_url"), "/" + repository + "/releases/tag/");
        JSONArray files = release.optJSONArray("assets");
        if (page == null || files == null) return null;
        JSONObject apk = asset(files, APK_NAME);
        JSONObject metadata = asset(files, ASSET_NAME);
        if (apk == null || metadata == null || apk.optLong("size") <= 0
                || metadata.optLong("size") <= 0 || metadata.optLong("size") > MAX_METADATA_BYTES) return null;
        String downloadPath = "/" + repository + "/releases/download/";
        URI apkUrl = githubUri(apk.optString("browser_download_url"), downloadPath);
        URI metadataUrl = githubUri(metadata.optString("browser_download_url"), downloadPath);
        if (apkUrl == null || metadataUrl == null
                || !apkUrl.getPath().endsWith("/" + APK_NAME)
                || !metadataUrl.getPath().endsWith("/" + ASSET_NAME)
                || !apkUrl.resolve(".").equals(metadataUrl.resolve("."))) return null;
        String tag = apkUrl.getPath().substring(downloadPath.length(), apkUrl.getPath().length() - APK_NAME.length() - 1);
        if (!tag.equals(page.getPath().substring(("/" + repository + "/releases/tag/").length()))) return null;

        JSONObject published = loader.load(metadataUrl, MAX_METADATA_BYTES);
        long newer = timestamp(published);
        String hash = published.optString("sha256");
        String githubDigest = apk.optString("digest");
        if (published.optInt("schema") != SCHEMA || newer <= installed
                || !repository.equalsIgnoreCase(published.optString("repository"))
                || !APK_NAME.equals(published.optString("apkName"))
                || published.optLong("apkBytes") != apk.optLong("size")
                || !hash.matches("(?i)[0-9a-f]{64}")
                || (!githubDigest.isEmpty() && !apk.isNull("digest")
                        && !githubDigest.equalsIgnoreCase("sha256:" + hash))) return null;
        return new Update(newer, page);
    }

    private static JSONObject asset(JSONArray assets, String name) {
        JSONObject result = null;
        for (int index = 0; index < assets.length(); index++) {
            JSONObject entry = assets.optJSONObject(index);
            if (entry == null || !name.equals(entry.optString("name")) || !"uploaded".equals(entry.optString("state"))) continue;
            if (result != null) return null;
            result = entry;
        }
        return result;
    }

    private static long timestamp(JSONObject document) {
        Object value = document.opt("buildTimestamp");
        if (!(value instanceof Long) && !(value instanceof Integer)) return 0;
        long time = ((Number) value).longValue();
        return time >= 946684800000L && time < 7258118400000L ? time : 0;
    }

    private static boolean validRepository(String repository) {
        return repository.matches("[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}")
                && !repository.endsWith("/.") && !repository.endsWith("/..");
    }

    private static URI githubUri(String value, String expectedPath) {
        try {
            URI uri = new URI(value);
            String path = uri.getPath();
            if (!"https".equals(uri.getScheme()) || !"github.com".equalsIgnoreCase(uri.getHost())
                    || uri.getPort() != -1 || uri.getUserInfo() != null || uri.getRawQuery() != null
                    || uri.getFragment() != null || path == null
                    || path.length() <= expectedPath.length()
                    || !path.regionMatches(true, 0, expectedPath, 0, expectedPath.length())) return null;
            return uri;
        } catch (URISyntaxException error) {
            return null;
        }
    }
}
