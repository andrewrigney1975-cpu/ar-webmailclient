package com.despatch.mobile;

import android.os.Bundle;
import com.despatch.mobile.mail.DespatchMailPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-specific plugins must be registered before the bridge starts.
        registerPlugin(DespatchMailPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
