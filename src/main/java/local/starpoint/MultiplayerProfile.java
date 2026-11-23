package local.starpoint;

import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

final class MultiplayerProfile {
    enum Mode { OFFLINE, LAN_HOST, VPN_HOST, JOIN }

    final Mode mode;
    final String address;
    final String token;

    private MultiplayerProfile(Mode mode, String address, String token) {
        this.mode = mode;
        this.address = address;
        this.token = token;
    }

    static MultiplayerProfile offline() {
        return new MultiplayerProfile(Mode.OFFLINE, "", "");
    }

    static MultiplayerProfile of(Mode mode, String address, String token) {
        address = address.trim();
        token = token.trim();
        switch (mode) {
            case OFFLINE:
                return offline();
            case LAN_HOST:
            case VPN_HOST:
                if (!isPrivateAddress(address)) {
                    throw new IllegalArgumentException("请输入本机局域网或组网的 IPv4 地址。");
                }
                return new MultiplayerProfile(mode, address, "");
            case JOIN:
                if (!isHubUrl(address)) {
                    throw new IllegalArgumentException("请输入完整的 Hub 地址，例如 http://192.168.1.25:8004。");
                }
                if (!token.matches("[A-Za-z0-9_-]{32,128}")) {
                    throw new IllegalArgumentException("联机凭据需为 32 到 128 位字母、数字、下划线或短横线。");
                }
                return new MultiplayerProfile(mode, address, token);
            default:
                throw new IllegalArgumentException("未知的联机方式。");
        }
    }

    private static AtomicFile file(Context context) {
        return new AtomicFile(new File(context.getNoBackupFilesDir(), "multiplayer-profile.json"));
    }

    static MultiplayerProfile read(Context context) throws IOException {
        AtomicFile file = file(context);
        try {
            JSONObject value = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
            return of(Mode.valueOf(value.getString("mode")), value.optString("address"), value.optString("token"));
        } catch (FileNotFoundException error) {
            if (!file.getBaseFile().exists()) return offline();
            throw error;
        } catch (JSONException | IllegalArgumentException error) {
            throw new IOException("联机配置无法读取，请重新保存设置。");
        }
    }

    void save(Context context) throws IOException {
        byte[] bytes;
        try {
            bytes = new JSONObject().put("mode", mode.name()).put("address", address).put("token", token)
                    .toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException error) {
            throw new IOException("联机配置无法保存。", error);
        }
        AtomicFile file = file(context);
        FileOutputStream output = file.startWrite();
        try {
            output.write(bytes);
            file.finishWrite(output);
        } catch (IOException error) {
            file.failWrite(output);
            throw error;
        }
    }

    String apply(Map<String, String> env, List<String> availableAddresses) {
        env.put("MULTI_MODE", "embedded");
        env.put("SESSION_HOST", "127.0.0.1");
        env.put("SESSION_PUBLIC_HOST", "127.0.0.1");
        if (mode == Mode.OFFLINE) return "单机";

        if (mode == Mode.JOIN) {
            env.put("MULTI_MODE", "client");
            env.put("MULTI_HUB_URL", address);
            env.put("MULTI_HUB_TOKEN", token);
            return "加入其他后端";
        }

        if (mode == Mode.LAN_HOST && !availableAddresses.contains(address)) {
            return "单机。本机暂无所选联机地址，请连接原网络后从联机设置重启服务。";
        }
        String bind = mode == Mode.LAN_HOST ? address : "127.0.0.1";
        env.put("MULTI_MODE", "host");
        env.put("MULTI_HUB_HOST", bind);
        env.put("SESSION_HOST", bind);
        env.put("SESSION_PUBLIC_HOST", address);
        if (mode == Mode.VPN_HOST) env.put("LOCAL_HUB_LOOPBACK_HOST", "1");
        return mode == Mode.LAN_HOST ? "局域网主机" : "VPN 转发主机";
    }

    static List<String> localAddresses() throws IOException {
        List<String> addresses = new ArrayList<>();
        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface adapter = interfaces.nextElement();
            if (!adapter.isUp()) continue;
            Enumeration<InetAddress> assigned = adapter.getInetAddresses();
            while (assigned.hasMoreElements()) {
                InetAddress address = assigned.nextElement();
                String host = address.getHostAddress();
                if (address instanceof Inet4Address && isPrivateAddress(host) && !addresses.contains(host)) {
                    addresses.add(host);
                }
            }
        }
        return addresses;
    }

    static boolean isPrivateAddress(String address) {
        String[] parts = address.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] numbers = new int[4];
        for (int i = 0; i < parts.length; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            numbers[i] = Integer.parseInt(parts[i]);
            if (numbers[i] > 255) return false;
        }
        return numbers[0] == 10
                || numbers[0] == 172 && numbers[1] >= 16 && numbers[1] <= 31
                || numbers[0] == 192 && numbers[1] == 168
                || numbers[0] == 100 && numbers[1] >= 64 && numbers[1] <= 127;
    }

    static boolean isHubUrl(String address) {
        try {
            URI url = new URI(address);
            String scheme = url.getScheme();
            String host = url.getHost();
            if (host == null || url.getRawUserInfo() != null || url.getRawQuery() != null
                    || url.getRawFragment() != null || !("http".equals(scheme) || "https".equals(scheme))) return false;
            String path = url.getRawPath();
            int port = url.getPort();
            if (!("".equals(path) || "/".equals(path)) || port == 0 || port > 65535) return false;
            if ("https".equals(scheme)) return true;
            return "127.0.0.1".equals(host) || isPrivateAddress(host)
                    || host.endsWith(".ts.net") || host.endsWith(".local");
        } catch (URISyntaxException error) {
            return false;
        }
    }
}
