package local.starpoint;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.os.PersistableBundle;
import android.os.SystemClock;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;
import org.json.JSONArray;

public final class MultiplayerSettings extends Activity {
    private static final String LOCAL_API = "http://127.0.0.1:8001";
    private Spinner mode;
    private EditText address;
    private EditText token;
    private TextView help;
    private TextView status;
    private Button apply;
    private Button createCredential;
    private Button manageCredentials;
    private Button probe;
    private List<String> localAddresses;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        setContentView(scroll);

        TextView title = new TextView(this);
        title.setTextSize(22);
        title.setText("联机设置");
        content.addView(title);
        mode = new Spinner(this);
        ArrayAdapter<String> modes = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item,
                Arrays.asList("单机", "局域网主机", "VPN 转发主机", "加入其他后端"));
        modes.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        mode.setAdapter(modes);
        content.addView(mode);
        address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        content.addView(address);
        token = new EditText(this);
        token.setSingleLine(true);
        token.setHint("访客凭据");
        token.setSaveEnabled(false);
        token.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        content.addView(token);
        help = new TextView(this);
        content.addView(help);
        apply = button(content, "保存并重启服务", this::applyProfile);
        probe = button(content, "检测当前 Hub", this::probeHub);
        createCredential = button(content, "生成访客凭据", this::createCredential);
        manageCredentials = button(content, "管理访客凭据", this::manageCredentials);
        button(content, "关闭", this::finish);
        status = new TextView(this);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status);

        try {
            localAddresses = MultiplayerProfile.localAddresses();
        } catch (IOException error) {
            localAddresses = Collections.emptyList();
        }
        try {
            MultiplayerProfile saved = MultiplayerProfile.read(this);
            mode.setSelection(saved.mode.ordinal());
            address.setText(saved.address);
            token.setText(saved.token);
        } catch (IOException error) {
            status.setText(error.getMessage());
        }
        mode.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                showMode();
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        showMode();
    }

    private Button button(LinearLayout content, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(view -> action.run());
        content.addView(button);
        return button;
    }

    private MultiplayerProfile.Mode selectedMode() {
        return MultiplayerProfile.Mode.values()[mode.getSelectedItemPosition()];
    }

    private void showMode() {
        MultiplayerProfile.Mode selected = selectedMode();
        boolean isJoin = selected == MultiplayerProfile.Mode.JOIN;
        boolean isHost = selected == MultiplayerProfile.Mode.LAN_HOST || selected == MultiplayerProfile.Mode.VPN_HOST;
        address.setVisibility(isJoin || isHost ? View.VISIBLE : View.GONE);
        address.setHint(isJoin ? "房主地址，例如 http://192.168.1.25:8004" : "本机联机 IPv4 地址");
        token.setVisibility(isJoin ? View.VISIBLE : View.GONE);
        probe.setVisibility(isJoin ? View.VISIBLE : View.GONE);
        createCredential.setVisibility(isHost ? View.VISIBLE : View.GONE);
        manageCredentials.setVisibility(isHost ? View.VISIBLE : View.GONE);
        if (selected == MultiplayerProfile.Mode.LAN_HOST) {
            help.setText("填写访客可访问的本机地址。同一 Wi-Fi 或支持直接入站的组网 VPN 可用。\n"
                    + "当前私网地址：" + (localAddresses.isEmpty() ? "未检测到" : String.join("、", localAddresses))
                    + "\n启用主机后，生成一条访客凭据交给对方。");
        } else if (selected == MultiplayerProfile.Mode.VPN_HOST) {
            help.setText("适用于把入站连接转发到本机回环地址的 VPN。填写本机 VPN 地址。"
                    + "组网访问规则只向访客开放 TCP 8003 和 8004。");
        } else if (isJoin) {
            help.setText("保存后，从游戏的领主战房间列表输入房间号。Hub 暂时不可用时仍可继续单机。");
        } else {
            help.setText("本地服务只接收本机连接。");
        }
    }

    private void applyProfile() {
        try {
            MultiplayerProfile profile = MultiplayerProfile.of(selectedMode(),
                    address.getText().toString(), token.getText().toString());
            if (profile.mode == MultiplayerProfile.Mode.LAN_HOST
                    && !MultiplayerProfile.localAddresses().contains(profile.address)) {
                throw new IllegalArgumentException("所填地址当前不在本机网络接口上。");
            }
            profile.save(this);
            runAction("正在重启本地服务…", () -> {
                if (BackendStartup.hasServiceProcess(this) || BackendStartup.isReady()) {
                    startService(new Intent(this, OfflineServer.class).setAction(BackendStartup.STOP));
                    long deadline = SystemClock.elapsedRealtime() + 15_000L;
                    while (BackendStartup.hasServiceProcess(this) || BackendStartup.isReady()) {
                        if (SystemClock.elapsedRealtime() >= deadline) throw new IOException("等待后端退出超时，请重试。");
                        SystemClock.sleep(250);
                    }
                }
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    startActivity(new Intent(this, OfflineEntry.class));
                    finish();
                });
            });
        } catch (IllegalArgumentException | IOException error) {
            status.setText(error.getMessage());
        }
    }

    private void createCredential() {
        runAction("正在生成…", () -> {
            JSONObject state = request("/healthz", null);
            if (!"host".equals(state.getJSONObject("multiplayer").getString("mode"))) {
                throw new IOException("请先保存设置并启动主机。");
            }
            JSONObject issued = request("/api/server/multiplayer/credentials",
                    new JSONObject().put("label", "Android 联机访客"));
            String secret = issued.getString("token");
            String publishedAddress = MultiplayerProfile.read(this).address;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                status.setText("已生成访客凭据。");
                AlertDialog result = new AlertDialog.Builder(this)
                        .setTitle("访客凭据")
                        .setMessage("Hub 地址\nhttp://" + publishedAddress + ":8004\n\n" + secret
                                + "\n\n凭据只显示一次，请交给要加入的玩家。")
                        .setNegativeButton("关闭", null)
                        .setPositiveButton("复制凭据", (ignored, which) -> copyCredential(secret)).create();
                if (result.getWindow() != null) {
                    result.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }
                result.show();
            });
        });
    }

    private void copyCredential(String secret) {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        ClipData clip = ClipData.newPlainText("联机凭据", secret);
        if (Build.VERSION.SDK_INT >= 33) {
            PersistableBundle metadata = new PersistableBundle();
            metadata.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
            clip.getDescription().setExtras(metadata);
        }
        clipboard.setPrimaryClip(clip);
    }

    private void manageCredentials() {
        runAction("正在读取访客凭据…", () -> {
            JSONArray records = new JSONArray(exchange("GET", "/api/server/multiplayer/credentials", null));
            List<String> labels = new ArrayList<>();
            List<String> ids = new ArrayList<>();
            for (int index = 0; index < records.length(); index++) {
                JSONObject record = records.getJSONObject(index);
                if (!record.isNull("revokedAt")) continue;
                String id = record.getString("credentialId");
                if (!id.matches("[A-Za-z0-9_-]{8,128}")) continue;
                ids.add(id);
                labels.add(record.optString("label", "联机访客") + " · " + id.substring(0, 8));
            }
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                status.setText(labels.isEmpty() ? "当前没有有效的访客凭据。" : "");
                if (labels.isEmpty()) return;
                new AlertDialog.Builder(this).setTitle("选取要撤销的凭据")
                        .setItems(labels.toArray(new String[0]), (list, index) -> new AlertDialog.Builder(this)
                                .setTitle("撤销 " + labels.get(index))
                                .setMessage("使用这条凭据连接的访客会断线。")
                                .setNegativeButton("取消", null)
                                .setPositiveButton("撤销", (confirm, choice) -> runAction("正在撤销…", () -> {
                                    exchange("DELETE", "/api/server/multiplayer/credentials/" + ids.get(index), null);
                                    runOnUiThread(() -> status.setText("已撤销访客凭据。"));
                                })).show())
                        .setNegativeButton("关闭", null).show();
            });
        });
    }

    private void probeHub() {
        runAction("正在检测当前 Hub…", () -> {
            JSONObject state = request("/healthz", null).getJSONObject("multiplayer");
            if (!"client".equals(state.getString("mode"))) throw new IOException("请先保存并启动加入模式。");
            request("/api/server/multiplayer/probe", new JSONObject());
            JSONObject latest = request("/healthz", null).getJSONObject("multiplayer");
            JSONObject hub = latest.optJSONObject("hub");
            if (hub == null || !hub.optBoolean("available")) throw new IOException("当前无法连接房主 Hub。");
            JSONObject tcp = latest.getJSONObject("tcp");
            if (!tcp.optBoolean("available")) throw new IOException("Hub 已连接，战斗端口尚未就绪。");
            URI endpoint = new URI("tcp://" + tcp.getString("endpoint"));
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(endpoint.getHost(), endpoint.getPort()), 2000);
            } catch (IOException error) {
                throw new IOException("Hub 已连接，但本机无法访问房主的战斗端口。");
            }
            runOnUiThread(() -> status.setText("已连接房主 Hub，战斗端口可达。"));
        });
    }

    private interface Work { void run() throws Exception; }

    private void runAction(String message, Work work) {
        status.setText(message);
        apply.setEnabled(false);
        probe.setEnabled(false);
        createCredential.setEnabled(false);
        manageCredentials.setEnabled(false);
        new Thread(() -> {
            try {
                work.run();
            } catch (Exception error) {
                runOnUiThread(() -> status.setText(error instanceof IOException
                        ? error.getMessage() : "联机操作失败。请检查当前联机方式。"));
            } finally {
                runOnUiThread(() -> {
                    apply.setEnabled(true);
                    probe.setEnabled(true);
                    createCredential.setEnabled(true);
                    manageCredentials.setEnabled(true);
                });
            }
        }, "starpoint-multiplayer-settings").start();
    }

    private JSONObject request(String path, JSONObject payload) throws Exception {
        return new JSONObject(exchange(payload == null ? "GET" : "POST", path, payload));
    }

    private String exchange(String method, String path, JSONObject payload) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(LOCAL_API + path).openConnection(Proxy.NO_PROXY);
        try {
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(6000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestMethod(method);
            if (payload != null) {
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int statusCode = connection.getResponseCode();
            if (statusCode < 200 || statusCode >= 300) {
                throw new IOException("本地联机操作返回 HTTP " + statusCode + "。");
            }
            try (InputStream input = connection.getInputStream();
                    ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 32768) throw new IOException("本地联机响应超出范围。");
                    output.write(buffer, 0, count);
                }
                return new String(output.toByteArray(), StandardCharsets.UTF_8);
            }
        } finally {
            connection.disconnect();
        }
    }
}
