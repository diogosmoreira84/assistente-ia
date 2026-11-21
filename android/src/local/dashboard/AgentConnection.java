package local.dashboard;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.InetAddress;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.UUID;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

final class AgentConnection {
    private final SharedPreferences preferences;
    private final String deviceId;
    private String origin, fingerprint, token;
    private boolean portal;

    AgentConnection(Context context) {
        // The file name predates the rename; it keeps existing pairings.
        preferences = context.getSharedPreferences("phonebox", Context.MODE_PRIVATE);
        deviceId = preferences.getString("device", UUID.randomUUID().toString());
        preferences.edit().putString("device", deviceId).apply();
        origin = preferences.getString("origin", "");
        fingerprint = preferences.getString("fingerprint", "");
        token = preferences.getString("token", "");
        portal = preferences.getBoolean("portal", false);
        // Direct PhoneBox pairing is gone: an old direct connection is cleared so the app asks for a portal code.
        if (!token.isEmpty() && !portal) {
            origin = fingerprint = token = "";
            preferences.edit().remove("origin").remove("fingerprint").remove("token").remove("portal").apply();
        }
    }

    boolean paired() { return !token.isEmpty(); }
    boolean portal() { return portal; }
    void forget() throws Exception {
        origin = fingerprint = token = "";
        portal = false;
        preferences.edit().remove("origin").remove("fingerprint").remove("token").remove("portal").commit();
    }

    private void savePairing(String address, String pin, String key, boolean usesPortal) throws IOException {
        if (!preferences.edit().putString("origin", address).putString("fingerprint", pin)
                .putString("token", key).putBoolean("portal", usesPortal).commit()) {
            throw new IOException("Could not save the connection.");
        }
        origin = address;
        fingerprint = pin;
        token = key;
        portal = usesPortal;
    }

    void pair(String link) throws Exception {
        Uri uri = Uri.parse(link.trim());
        if (!"assistenteia".equals(uri.getScheme()) || !"pair".equals(uri.getAuthority())) {
            throw new IOException("Scan the pairing code from Devices in your Assistente IA portal.");
        }
        pairPortal(uri);
    }

    JSONObject get(String path) throws Exception {
        return request(origin, fingerprint, token, path, "GET", null);
    }

    void decide(String id, String decision) throws Exception {
        request(origin, fingerprint, token, "/api/tablet/approval", "POST",
                new JSONObject().put("id", id).put("choice", decision));
    }

    void deleteLogs(String id) throws Exception {
        Object value = "all".equals(id) ? id : Long.valueOf(id);
        request(origin, fingerprint, token, "/api/tablet/logs/delete", "POST", new JSONObject().put("id", value));
    }

    private void pairPortal(Uri uri) throws Exception {
        String address = uri.getQueryParameter("url");
        String pin = uri.getQueryParameter("pin");
        String code = uri.getQueryParameter("code");
        if (address == null || !address.matches("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?")
                || pin == null || !pin.matches("[a-fA-F0-9]{64}")
                || code == null || !code.matches("[A-Za-z0-9_-]{40,64}")) {
            throw new IOException("Invalid Assistente IA pairing code.");
        }
        JSONObject response = request(address, pin, "", "/api/pair/claim", "POST",
                new JSONObject().put("code", code).put("name", android.os.Build.MODEL));
        String key = response.getString("token");
        if (key.isEmpty() || !pin.equalsIgnoreCase(response.getString("fingerprint"))) {
            throw new IOException("Invalid pairing response.");
        }
        savePairing(address, pin, key, true);
    }

    private JSONObject request(String address, final String pin, String key, String path, String method,
                               JSONObject body) throws Exception {
        SSLContext ssl = SSLContext.getInstance("TLSv1.2");
        ssl.init(null, new X509TrustManager[] { new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
                throw new CertificateException("Client certificates unsupported");
            }
            public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
                try {
                    if (chain.length == 0) throw new CertificateException("Missing certificate");
                    byte[] hash = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                    StringBuilder hex = new StringBuilder();
                    for (byte value : hash) {
                        hex.append(Character.forDigit((value >> 4) & 15, 16));
                        hex.append(Character.forDigit(value & 15, 16));
                    }
                    if (!pin.equalsIgnoreCase(hex.toString())) throw new CertificateException("Certificate changed");
                } catch (Exception e) {
                    throw new CertificateException(e);
                }
            }
        } }, null);
        HttpsURLConnection connection = (HttpsURLConnection) new URL(address + path).openConnection();
        try {
            connection.setSSLSocketFactory(new Tls12Factory(ssl.getSocketFactory()));
            // The trust manager verifies the exact certificate from the pairing link.
            connection.setHostnameVerifier(new HostnameVerifier() {
                public boolean verify(String host, SSLSession session) { return true; }
            });
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(4000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("X-Assistente-Device", deviceId);
            connection.setRequestProperty("X-Assistente-App", "android");
            if (!key.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + key);
            if (body != null) {
                byte[] data = body.toString().getBytes("UTF-8");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(data.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(data); }
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new HttpError(status);
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream response = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (response.size() + count > 1024 * 1024) throw new IOException("Agent response is too large.");
                    response.write(buffer, 0, count);
                }
                return response.size() == 0 ? new JSONObject() : new JSONObject(response.toString("UTF-8"));
            }
        } finally {
            connection.disconnect();
        }
    }

    static final class HttpError extends IOException {
        final int status;
        HttpError(int status) { super("HTTP " + status); this.status = status; }
    }

    private static final class Tls12Factory extends SSLSocketFactory {
        private final SSLSocketFactory factory;
        Tls12Factory(SSLSocketFactory factory) { this.factory = factory; }
        public String[] getDefaultCipherSuites() { return factory.getDefaultCipherSuites(); }
        public String[] getSupportedCipherSuites() { return factory.getSupportedCipherSuites(); }
        private Socket tls12(Socket socket) {
            if (socket instanceof SSLSocket) ((SSLSocket) socket).setEnabledProtocols(new String[]{"TLSv1.2"});
            return socket;
        }
        public Socket createSocket() throws IOException { return tls12(factory.createSocket()); }
        public Socket createSocket(Socket socket, String host, int port, boolean close) throws IOException {
            return tls12(factory.createSocket(socket, host, port, close));
        }
        public Socket createSocket(String host, int port) throws IOException { return tls12(factory.createSocket(host, port)); }
        public Socket createSocket(String host, int port, InetAddress local, int localPort) throws IOException {
            return tls12(factory.createSocket(host, port, local, localPort));
        }
        public Socket createSocket(InetAddress host, int port) throws IOException { return tls12(factory.createSocket(host, port)); }
        public Socket createSocket(InetAddress host, int port, InetAddress local, int localPort) throws IOException {
            return tls12(factory.createSocket(host, port, local, localPort));
        }
    }
}
