package local.dashboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Handles the Allow and Deny buttons on an approval notification. */
public class DecisionReceiver extends BroadcastReceiver {
    @Override public void onReceive(final Context context, Intent intent) {
        final String id = intent.getStringExtra("id");
        final String choice = intent.getStringExtra("choice");
        final int notification = intent.getIntExtra("notification", 0);
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,128}") || !("allow".equals(choice) || "deny".equals(choice))) return;
        WatchService.markAnswered(id);
        Notifier.result(context, notification, "allow".equals(choice) ? "Allowing…" : "Denying…", "Sending your answer to the agent.");
        final PendingResult pending = goAsync();
        new Thread(new Runnable() { public void run() {
            try {
                new AgentConnection(context).decide(id, choice);
                Notifier.result(context, notification, "allow".equals(choice) ? "Allowed" : "Denied",
                        "Your answer was sent to the agent.");
            } catch (AgentConnection.HttpError e) {
                Notifier.result(context, notification, "Already answered",
                        e.status == 410 || e.status == 409 ? "This request expired or was answered elsewhere." : "The portal refused the answer.");
            } catch (Exception e) {
                Notifier.result(context, notification, "Not sent", "Couldn't reach the portal. Answer in the app or terminal.");
            } finally {
                pending.finish();
            }
        } }).start();
    }
}
