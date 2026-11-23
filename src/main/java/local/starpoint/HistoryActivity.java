package local.starpoint;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class HistoryActivity extends Activity {
    private static final Pattern OPEN = Pattern.compile("starpoint-history://open/(payments|gacha)/([a-f0-9]{48})");
    private static final String HOST = "http://127.0.0.1:8001";
    private WebView page;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        String target = getIntent().getDataString();
        Matcher match = OPEN.matcher(target == null ? "" : target);
        if (!match.matches()) {
            finish();
            return;
        }

        String base = "/api/index.php/payment/local/history/view/" + match.group(2) + "/";
        page = new WebView(this);
        page.getSettings().setAllowFileAccess(false);
        page.getSettings().setAllowContentAccess(false);
        page.getSettings().setUseWideViewPort(true);
        page.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                Uri uri = request.getUrl();
                if ("starpoint-history://close".equals(uri.toString())) {
                    finish();
                    return true;
                }
                return !"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost())
                        || uri.getPort() != 8001
                        || !(base.concat("payments").equals(uri.getPath()) || base.concat("gacha").equals(uri.getPath()));
            }
        });
        setContentView(page);
        page.loadUrl(HOST + base + match.group(1));
    }

    @Override protected void onDestroy() {
        if (page != null) {
            if (page.getParent() instanceof ViewGroup) ((ViewGroup) page.getParent()).removeView(page);
            page.destroy();
            page = null;
        }
        super.onDestroy();
    }
}
