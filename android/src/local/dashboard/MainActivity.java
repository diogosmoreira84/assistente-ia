package local.dashboard;

import android.app.Activity;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String PANEL = "file:///android_asset/index.html";
    private static final int CAMERA_PERMISSION = 21;
    private static final int SCAN_REQUEST = 22;
    private static final int NOTIFY_PERMISSION = 23;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WebView web;
    private AgentConnection agent;
    private boolean panelReady;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        // A tablet works as a desk dashboard and stays on; a phone follows its normal screen timeout.
        if (getResources().getConfiguration().smallestScreenWidthDp >= 600) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        agent = new AgentConnection(this);
        Notifier.channels(this);
        WatchService.start(this);
        askNotificationPermission();
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccessFromFileURLs(false);
        web.getSettings().setAllowUniversalAccessFromFileURLs(false);
        web.getSettings().setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !PANEL.equals(url);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!PANEL.equals(url)) return;
                panelReady = true;
                showPairingLink();
            }
        });
        web.addJavascriptInterface(new PanelBridge(), "AcerPanel");
        setContentView(web);
        web.loadUrl(PANEL);
    }

    @Override protected void onResume() {
        super.onResume();
        WatchService.appVisible = true;
        if (panelReady) submit("refresh", null);
    }

    @Override protected void onPause() {
        WatchService.appVisible = false;
        super.onPause();
    }

    private void askNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33 || !agent.paired()) return;
        if (checkCallingOrSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        try {
            Activity.class.getMethod("requestPermissions", String[].class, int.class)
                    .invoke(this, new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFY_PERMISSION);
        } catch (Exception ignored) {
        }
    }

    private boolean notificationsAllowed() {
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkCallingOrSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        try {
            Object manager = getSystemService(NOTIFICATION_SERVICE);
            return (Boolean) manager.getClass().getMethod("areNotificationsEnabled").invoke(manager);
        } catch (Exception e) {
            return true;
        }
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (panelReady) showPairingLink();
    }

    private void showPairingLink() {
        Intent intent = getIntent();
        String link = intent.getStringExtra("pairing_link");
        Uri data = intent.getData();
        intent.removeExtra("pairing_link");
        intent.setData(null);
        if (link == null && data != null && "assistenteia".equals(data.getScheme())) link = data.toString();
        prefill(link);
    }

    private void prefill(String link) {
        if (link == null || link.length() > 2048 || !link.startsWith("assistenteia://pair?")) return;
        Uri code = Uri.parse(link);
        String name = code.getQueryParameter("profile");
        String address = code.getQueryParameter("url");
        String hint = name == null ? "" : "Connect to " + name + "'s portal" + (address == null ? "" : " at " + address) + "?";
        web.evaluateJavascript("window.offerPairing(" + quote(link) + "," + quote(hint) + ");", null);
    }

    private String quote(String value) {
        return JSONObject.quote(value).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }

    private void beginScan() {
        if (android.os.Build.VERSION.SDK_INT >= 23
                && checkCallingOrSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            try {
                Activity.class.getMethod("requestPermissions", String[].class, int.class)
                        .invoke(this, new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
            } catch (Exception e) {
                web.evaluateJavascript("window.pairingMessage('Camera permission is unavailable.');", null);
            }
        } else launchScan();
    }

    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == CAMERA_PERMISSION && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) launchScan();
    }

    private void launchScan() { startActivityForResult(new Intent(this, ScanActivity.class), SCAN_REQUEST); }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SCAN_REQUEST && data != null) {
            if (result == RESULT_OK) prefill(data.getStringExtra("link"));
            else {
                String error = data.getStringExtra("error");
                if (error != null) web.evaluateJavascript("window.pairingMessage(" + quote(error) + ");", null);
            }
        }
    }

    public final class PanelBridge {
        @JavascriptInterface public void alert() {
            Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) vibrator.vibrate(180);
        }
        @JavascriptInterface public void refresh() { submit("refresh", null); }
        @JavascriptInterface public String watchState() {
            try {
                String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                return new JSONObject().put("enabled", WatchService.enabled(MainActivity.this))
                        .put("allowed", notificationsAllowed()).put("portal", agent.portal())
                        .put("version", version).put("tablet", getResources().getConfiguration().smallestScreenWidthDp >= 600).toString();
            } catch (Exception e) {
                return "{}";
            }
        }
        @JavascriptInterface public void setWatch(boolean on) {
            WatchService.setEnabled(MainActivity.this, on);
            if (on) runOnUiThread(new Runnable() { public void run() { askNotificationPermission(); } });
        }
        @JavascriptInterface public void notificationSettings() {
            runOnUiThread(new Runnable() { public void run() {
                Intent intent = new Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                        .putExtra("android.provider.extra.APP_PACKAGE", getPackageName())
                        .putExtra("app_package", getPackageName()).putExtra("app_uid", getApplicationInfo().uid);
                try { startActivity(intent); }
                catch (Exception e) { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
            } });
        }
        @JavascriptInterface public void batterySettings() {
            runOnUiThread(new Runnable() { public void run() {
                try { startActivity(new Intent("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", Uri.parse("package:" + getPackageName()))); }
                catch (Exception e) {
                    try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
                    catch (Exception ignored) {}
                }
            } });
        }
        @JavascriptInterface public void pair(final String link) {
            submit("pair", new Operation() { public void run() throws Exception { agent.pair(link); } });
        }
        @JavascriptInterface public void forget() {
            submit("forget", new Operation() { public void run() throws Exception { agent.forget(); } });
        }
        @JavascriptInterface public void scan() {
            runOnUiThread(new Runnable() {
                public void run() { beginScan(); }
            });
        }
        @JavascriptInterface public void deleteLogs(final String id) {
            if (id == null || (!"all".equals(id) && !id.matches("[0-9]{1,18}"))) return;
            submit("deleteLogs", new Operation() { public void run() throws Exception { agent.deleteLogs(id); } });
        }
        @JavascriptInterface public void wifi() {
            runOnUiThread(new Runnable() {
                public void run() { startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); }
            });
        }
        @JavascriptInterface public void decide(final String id, final String decision) {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}")
                    || !("allow".equals(decision) || "deny".equals(decision))) return;
            submit("decision", new Operation() {
                public void run() throws Exception { agent.decide(id, decision); }
            });
        }
    }

    private interface Operation { void run() throws Exception; }

    private void submit(final String action, final Operation operation) {
        if (worker.isShutdown()) return;
        worker.execute(new Runnable() { public void run() {
            JSONObject result = new JSONObject();
            try {
                result.put("action", action);
                try {
                    if (operation != null) operation.run();
                    if ("pair".equals(action)) {
                        WatchService.start(MainActivity.this);
                        runOnUiThread(new Runnable() { public void run() { askNotificationPermission(); } });
                    }
                    if ("forget".equals(action)) stopService(new Intent(MainActivity.this, WatchService.class));
                } catch (AgentConnection.HttpError e) {
                    result.put("error", (e.status == 410 || e.status == 409) && "decision".equals(action)
                            ? "This request was already answered." : "The portal returned " + e.getMessage() + ".");
                } catch (Exception e) {
                    result.put("error", "pair".equals(action) && e instanceof java.io.IOException
                            ? e.getMessage() : "Could not reach the portal.");
                }
                result.put("paired", agent.paired());
                result.put("portal", agent.portal());
                if (agent.paired()) loadPanel(result);
            } catch (Exception e) {
                try { result.put("offline", true); } catch (Exception ignored) {}
            }
            final String json = result.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
            runOnUiThread(new Runnable() {
                public void run() {
                    if (web != null) web.evaluateJavascript("window.receivePanel(" + json + ");", null);
                }
            });
        } });
    }

    private void loadPanel(JSONObject result) throws Exception {
        try {
            JSONObject data = agent.get("/api/tablet/dashboard");
            result.put("profile", data.optString("profile"));
            result.put("portalLogs", data.optJSONArray("logs"));
            if (!data.optBoolean("online")) {
                result.put("offline", true).put("connectionError", "Portal connected · desktop agent offline");
            } else {
                JSONObject state = data.optJSONObject("state");
                if (state != null) state.put("ts", data.optLong("updated"));
                result.put("state", state);
            }
            result.put("approvals", new JSONObject().put("items", data.optJSONArray("approvals")));
            result.put("work", new JSONObject().put("sessions", data.optJSONArray("sessions")));
            result.put("quotas", new JSONObject().put("providers", data.optJSONArray("quotas")));
        } catch (AgentConnection.HttpError e) {
            result.put("offline", true).put("connectionError", e.status == 401
                    ? "Device disconnected in the portal. Scan a new code." : "Portal unavailable.");
        }
    }

    @Override public void onDestroy() {
        worker.shutdownNow();
        web.removeJavascriptInterface("AcerPanel");
        web.destroy();
        web = null;
        super.onDestroy();
    }
}
