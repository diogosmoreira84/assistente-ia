package local.dashboard;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.Build;

/**
 * Notifications for Assistente IA (by Diogo Moreira). The app compiles against API 19 so it still runs on the
 * Acer tablet; newer platform features (channels, categories, unlock-to-approve) are reached through reflection.
 */
final class Notifier {
    static final String REQUESTS = "requests", UPDATES = "updates", SERVICE = "service";
    static final int ONGOING_ID = 1;
    private static final int FLAG_IMMUTABLE = 0x04000000;
    private static final int ACCENT = 0xFF8FA8FF;

    private Notifier() {}

    static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        channel(context, REQUESTS, "Approval requests", "An agent is waiting for Allow or Deny.", 4);
        channel(context, UPDATES, "Alerts and summaries", "Finished tasks, usage alerts and the daily summary.", 3);
        channel(context, SERVICE, "Background connection", "Keeps Assistente IA listening for requests.", 1);
    }

    private static void channel(Context context, String id, String name, String description, int importance) {
        try {
            Class<?> type = Class.forName("android.app.NotificationChannel");
            Object channel = type.getConstructor(String.class, CharSequence.class, int.class).newInstance(id, name, importance);
            type.getMethod("setDescription", String.class).invoke(channel, description);
            Object manager = context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.getClass().getMethod("createNotificationChannel", type).invoke(manager, channel);
        } catch (Exception ignored) {
        }
    }

    static Notification.Builder builder(Context context, String channel) {
        Notification.Builder builder = null;
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                builder = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(context, channel);
            } catch (Exception ignored) {
            }
        }
        if (builder == null) builder = new Notification.Builder(context);
        builder.setSmallIcon(icon(context, "ic_stat")).setShowWhen(true);
        call(builder, "setColor", int.class, ACCENT);
        return builder;
    }

    static int icon(Context context, String name) {
        int id = context.getResources().getIdentifier(name, "drawable", context.getPackageName());
        return id != 0 ? id : android.R.drawable.ic_dialog_info;
    }

    static void call(Object target, String method, Class<?> type, Object value) {
        try {
            target.getClass().getMethod(method, type).invoke(target, value);
        } catch (Exception ignored) {
        }
    }

    static PendingIntent openApp(Context context, int request) {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
    }

    static Notification ongoing(Context context, String text) {
        Notification.Builder builder = builder(context, SERVICE)
                .setContentTitle("Assistente IA")
                .setContentText(text)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .setContentIntent(openApp(context, 1));
        call(builder, "setCategory", String.class, "service");
        return builder.build();
    }

    static int approvalId(String id) { return 1000 + (id.hashCode() & 0x00FFFFFF); }

    static void approval(Context context, String id, String agent, String project, String tool, String detail) {
        int notificationId = approvalId(id);
        String title = agent + " needs your approval";
        String summary = (project.isEmpty() ? "" : project + " · ") + tool;
        String body = summary + (detail.isEmpty() ? "" : "\n" + detail);
        Notification.Builder builder = builder(context, REQUESTS)
                .setContentTitle(title)
                .setContentText(summary + (detail.isEmpty() ? "" : ": " + detail))
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setLargeIcon(BitmapFactory.decodeResource(context.getResources(), icon(context, "icon")))
                .setPriority(Notification.PRIORITY_MAX)
                .setDefaults(Notification.DEFAULT_ALL)
                .setAutoCancel(true)
                .setContentIntent(openApp(context, notificationId));
        call(builder, "setCategory", String.class, "msg");
        call(builder, "setVisibility", int.class, 0);  // private: the command stays hidden on the lock screen
        action(context, builder, "Allow once", decision(context, id, "allow", notificationId), true);
        action(context, builder, "Deny", decision(context, id, "deny", notificationId), false);
        manager(context).notify(notificationId, builder.build());
    }

    private static PendingIntent decision(Context context, String id, String choice, int notificationId) {
        Intent intent = new Intent(context, DecisionReceiver.class)
                .setAction("local.dashboard.DECIDE." + choice + "." + id)
                .putExtra("id", id).putExtra("choice", choice).putExtra("notification", notificationId);
        return PendingIntent.getBroadcast(context, notificationId * 2 + ("allow".equals(choice) ? 1 : 0), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE);
    }

    /** Allow requires unlocking the phone on Android 12+, so nobody can approve from a locked screen. */
    private static void action(Context context, Notification.Builder builder, String title, PendingIntent intent, boolean unlock) {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                Class<?> type = Class.forName("android.app.Notification$Action$Builder");
                Object action = type.getConstructor(int.class, CharSequence.class, PendingIntent.class)
                        .newInstance(icon(context, "ic_stat"), title, intent);
                type.getMethod("setAuthenticationRequired", boolean.class).invoke(action, unlock);
                Object built = type.getMethod("build").invoke(action);
                Notification.Builder.class.getMethod("addAction", Class.forName("android.app.Notification$Action")).invoke(builder, built);
                return;
            } catch (Exception ignored) {
            }
        }
        builder.addAction(icon(context, "ic_stat"), title, intent);
    }

    static void result(Context context, int notificationId, String title, String text) {
        Notification.Builder builder = builder(context, REQUESTS)
                .setContentTitle(title).setContentText(text)
                .setPriority(Notification.PRIORITY_LOW).setAutoCancel(true)
                .setContentIntent(openApp(context, notificationId));
        call(builder, "setTimeoutAfter", long.class, 6000L);
        call(builder, "setOnlyAlertOnce", boolean.class, true);
        manager(context).notify(notificationId, builder.build());
    }

    static void notice(Context context, long id, String title, String text) {
        Notification.Builder builder = builder(context, UPDATES)
                .setContentTitle(title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setPriority(Notification.PRIORITY_DEFAULT).setDefaults(Notification.DEFAULT_ALL)
                .setAutoCancel(true).setContentIntent(openApp(context, (int) (id % 100000) + 200000));
        manager(context).notify((int) (id % 100000) + 200000, builder.build());
    }

    static void cancel(Context context, int notificationId) { manager(context).cancel(notificationId); }

    static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
