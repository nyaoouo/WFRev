package local.starpoint;

import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;

public final class BackendRecoveryProvider extends ContentProvider
        implements Application.ActivityLifecycleCallbacks {
    private static final String GAME_ACTIVITY = "air.com.leiting.wf.AppEntry";
    private final ReleaseUpdateCheck releaseUpdates = new ReleaseUpdateCheck();
    private Activity resumedGame;
    private int resumeGeneration;

    @Override public boolean onCreate() {
        Application application = (Application) getContext().getApplicationContext();
        application.registerActivityLifecycleCallbacks(this);
        return true;
    }

    @Override public void onActivityResumed(Activity activity) {
        if (!GAME_ACTIVITY.equals(activity.getComponentName().getClassName())) return;
        releaseUpdates.onGameResumed(activity);
        resumedGame = activity;
        int generation = ++resumeGeneration;
        new Thread(() -> {
            if (BackendStartup.isReady()) return;
            SystemClock.sleep(450);
            if (BackendStartup.isReady()) return;
            activity.runOnUiThread(() -> {
                if (resumedGame != activity || resumeGeneration != generation
                        || activity.isFinishing() || activity.isDestroyed()) return;
                Log.i("StarPoint", "Local backend unavailable after game resume; opening recovery");
                Intent recovery = new Intent(activity, OfflineEntry.class)
                        .putExtra(BackendStartup.RESUME_GAME, true);
                activity.startActivity(recovery);
            });
        }, "starpoint-resume-probe").start();
    }

    @Override public void onActivityPaused(Activity activity) {
        releaseUpdates.onGamePaused(activity);
        if (resumedGame == activity) resumedGame = null;
    }

    @Override public void onActivityCreated(Activity activity, Bundle state) {}
    @Override public void onActivityStarted(Activity activity) {}
    @Override public void onActivityStopped(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
    @Override public void onActivityDestroyed(Activity activity) {}

    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) {
        throw new UnsupportedOperationException();
    }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
