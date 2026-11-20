package local.starpoint;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class PaymentCheckoutActivity extends Activity {
    private static final Pattern CHECKOUT_INTENT =
            Pattern.compile("starpoint-checkout://order/([a-f0-9]{48})");
    private static final String CHECKOUT_BASE =
            "http://127.0.0.1:8001/api/index.php/payment/local/checkout/";
    private WebView page;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        String target = getIntent().getDataString();
        Matcher match = CHECKOUT_INTENT.matcher(target == null ? "" : target);
        if (!match.matches()) {
            finish();
            return;
        }

        String orderId = match.group(1);
        String checkout = CHECKOUT_BASE + orderId;
        String embeddedCheckout = checkout + "?embedded=1";
        String returnRoute = checkout + "/return";
        String gameReturn = "worldflipperlt://return?local_order=" + orderId;
        page = new WebView(this);
        WebSettings settings = page.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUseWideViewPort(true);
        page.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return true;
                String location = request.getUrl().toString();
                if (gameReturn.equals(location)) {
                    // The local return route has confirmed this order. Reveal the existing game.
                    finish();
                    return true;
                }
                return !checkout.equals(location) && !embeddedCheckout.equals(location)
                        && !returnRoute.equals(location);
            }
        });
        setContentView(page);
        page.loadUrl(embeddedCheckout);
    }

    @Override public void onBackPressed() {
        if (page == null) {
            super.onBackPressed();
            return;
        }
        page.evaluateJavascript("window.dispatchEvent(new Event('starpointcheckoutback', {cancelable:true}))",
                handled -> {
                    if (!"false".equals(handled) && !isFinishing()) finish();
                });
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
