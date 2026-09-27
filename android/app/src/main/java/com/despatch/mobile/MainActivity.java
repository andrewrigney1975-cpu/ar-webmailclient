package com.despatch.mobile;

import android.os.Bundle;
import com.despatch.mobile.mail.DespatchMailPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Notification tap: open the message. Extras are in MailNotifier. */
    public static final String ACTION_OPEN_MESSAGE = "com.despatch.mobile.action.OPEN_MESSAGE";
    /** Notification "Reply" action: open compose. */
    public static final String ACTION_REPLY = "com.despatch.mobile.action.REPLY";

    /** Background checks skip notifications while the app is on screen (the list updates instead). */
    public static volatile boolean isVisible = false;

    /** Tells the web app where a foldable's hinge is ("despatchfold" window event). */
    private FoldWatcher foldWatcher;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-specific plugins must be registered before the bridge starts.
        registerPlugin(DespatchMailPlugin.class);
        super.onCreate(savedInstanceState);
        foldWatcher = new FoldWatcher(this, json -> {
            if (getBridge() != null) getBridge().triggerWindowJSEvent("despatchfold", json);
            return kotlin.Unit.INSTANCE;
        });
    }

    @Override
    public void onStart() {
        super.onStart();
        foldWatcher.start();
    }

    @Override
    public void onStop() {
        foldWatcher.stop();
        super.onStop();
    }

    @Override
    public void onResume() {
        super.onResume();
        isVisible = true;
    }

    @Override
    public void onPause() {
        isVisible = false;
        super.onPause();
    }
}
