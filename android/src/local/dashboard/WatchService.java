package local.dashboard;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps listening to the portal while the app is closed and turns approval requests into notifications with
 * Allow and Deny buttons. While it runs, the portal tells the desktop agent that this phone can answer, so
 * Claude Code and Codex send their permission prompts here as well as to the terminal.
 */
public class WatchService extends Service {
    static volatile boolean appVisible;
    private volatile boolean running;
    private Thread loop;
    private final Map<String, Integer> shown = new HashMap<String, Integer>();
    private final Set<String> answered = new HashSet<String>();
    private String status = "";

    static boolean enabled(Context context) {
        return context.getSharedPreferences("watch", MODE_PRIVATE).getBoolean("enabled", true);
    }

    static void setEnabled(Context context, boolean on) {
        context.getSharedPreferences("watch", MODE_PRIVATE).edit().putBoolean("enabled", on).apply();
        if (on) start(context); else context.stopService(new Intent(context, WatchService.class));
    }

    static void start(Context context) {
        AgentConnection agent = new AgentConnection(context);
        if (!agent.paired() || !agent.portal() || !enabled(context)) return;
        Intent intent = new Intent(context, WatchService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Context.class.getMethod("startForegroundService", Intent.class).invoke(context, intent);
            } else context.startService(intent);
        } catch (Exception ignored) {
        }
    }

    static void markAnswered(String id) { ANSWERED.add(id); }
    private static final Set<String> ANSWERED = java.util.Collections.synchronizedSet(new HashSet<String>());

    @Override public void onCreate() {
        super.onCreate();
        Notifier.channels(this);
        foreground("Connecting to your portal…");
    }

    private void foreground(String text) {
        if (text.equals(status)) return;
        status = text;
        Notification notification = Notifier.ongoing(this, text);
        startForeground(Notifier.ONGOING_ID, notification);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!running) {
            running = true;
            loop = new Thread(new Runnable() { public void run() { watch(); } }, "assistente-watch");
            loop.start();
        }
        return START_STICKY;
    }

    private void watch() {
        AgentConnection agent = new AgentConnection(this);
        SharedPreferences prefs = getSharedPreferences("watch", MODE_PRIVATE);
        int failures = 0;
        while (running) {
            if (!agent.paired() || !agent.portal()) { stopSelf(); return; }
            try {
                JSONObject data = agent.get("/api/tablet/pending");
                failures = 0;
                foreground(data.optBoolean("online") ? "Listening for requests from your agents"
                        : "Connected · desktop agent offline");
                handle(data, prefs);
            } catch (AgentConnection.HttpError e) {
                if (e.status == 401) {
                    foreground("Disconnected in the portal. Open the app to pair again.");
                    sleep(60000);
                    continue;
                }
                failures++;
            } catch (Exception e) {
                failures++;
            }
            if (failures > 0) foreground("Can't reach the portal · retrying");
            sleep(failures == 0 ? 4000 : Math.min(30000, 4000L * failures));
        }
    }

    private void handle(JSONObject data, SharedPreferences prefs) throws Exception {
        JSONObject wants = data.optJSONObject("prefs");
        boolean approvals = wants == null || wants.optBoolean("pushApprovals", true);
        long now = data.optLong("now", System.currentTimeMillis() / 1000) * 1000;
        JSONArray items = data.optJSONArray("approvals");
        Set<String> open = new HashSet<String>();
        for (int i = 0; items != null && i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            String id = item.optString("id");
            if (id.isEmpty() || item.optLong("expiresAt") <= now || item.has("decision") && !item.isNull("decision")) continue;
            open.add(id);
            if (shown.containsKey(id) || answered.contains(id) || ANSWERED.contains(id)) continue;
            if (appVisible || !approvals) { answered.add(id); continue; }
            Notifier.approval(this, id, agentName(item.optString("source")), item.optString("project"),
                    item.optString("tool", "Request"), clip(item.optString("detail"), 300));
            shown.put(id, Notifier.approvalId(id));
        }
        Iterator<Map.Entry<String, Integer>> it = shown.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Integer> entry = it.next();
            if (!open.contains(entry.getKey())) {
                if (!ANSWERED.contains(entry.getKey())) Notifier.cancel(this, entry.getValue());
                it.remove();
            }
        }
        answered.retainAll(open);
        JSONArray notices = data.optJSONArray("notices");
        long last = prefs.getLong("lastNotice", -1), newest = last;
        for (int i = notices == null ? -1 : notices.length() - 1; i >= 0; i--) {
            JSONObject notice = notices.getJSONObject(i);
            long id = notice.optLong("id");
            newest = Math.max(newest, id);
            if (last < 0 || id <= last || appVisible) continue;  // first run only records where we are
            String kind = notice.optString("kind");
            String key = "finished".equals(kind) ? "pushFinished" : "quota".equals(kind) ? "pushQuota"
                    : "summary".equals(kind) ? "pushSummary" : null;
            if (key != null && wants != null && !wants.optBoolean(key, true)) continue;
            Notifier.notice(this, id, notice.optString("title"), notice.optString("body"));
        }
        if (newest != last) prefs.edit().putLong("lastNotice", Math.max(newest, 0)).apply();
    }

    static String agentName(String source) {
        String id = source.toLowerCase().replace(" ", "");
        return id.startsWith("claude") ? "Claude Code" : id.equals("codex") ? "Codex" : source.isEmpty() ? "An agent" : source;
    }

    private static String clip(String value, int length) {
        return value.length() <= length ? value : value.substring(0, length - 1) + "…";
    }

    private void sleep(long millis) {
        try { Thread.sleep(millis); } catch (InterruptedException e) { running = false; }
    }

    @Override public void onDestroy() {
        running = false;
        if (loop != null) loop.interrupt();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
