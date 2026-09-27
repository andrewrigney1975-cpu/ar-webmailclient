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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-specific plugins must be registered before the bridge starts.
        registerPlugin(DespatchMailPlugin.class);
        super.onCreate(savedInstanceState);
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
