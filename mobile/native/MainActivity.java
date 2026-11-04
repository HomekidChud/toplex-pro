package com.homekidchud.toplexpro;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ToplixNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
