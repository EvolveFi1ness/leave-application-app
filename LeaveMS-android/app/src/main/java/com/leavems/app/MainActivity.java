package com.leavems.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;

public class MainActivity extends Activity {
    private static final String PREFS = "leavems";
    private static final String KEY_URL = "server_url";
    private static final String DEFAULT_URL = "https://aki.tail4044e0.ts.net:8443/app.html";
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        String url = prefs.getString(KEY_URL, null);
        if (url == null) {
            askServerUrl(DEFAULT_URL, true);
        } else {
            web.loadUrl(url);
        }
    }

    private void askServerUrl(String current, boolean firstRun) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(48, 32, 48, 0);
        final EditText input = new EditText(this);
        input.setText(current);
        input.setHint("https://aki.tail4044e0.ts.net:8443/app.html");
        layout.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(firstRun ? "Connect to LeaveMS server" : "Server address")
                .setMessage(firstRun
                        ? "Enter the address of the computer running 'npm start'."
                        : "Enter the server address, then reload.")
                .setView(layout)
                .setCancelable(!firstRun)
                .setPositiveButton("Connect", (d, w) -> {
                    String url = input.getText().toString().trim();
                    if (!url.startsWith("http")) url = "http://" + url;
                    prefs.edit().putString(KEY_URL, url).apply();
                    web.loadUrl(url);
                })
                .setNegativeButton(firstRun ? "Use default" : "Cancel", (d, w) -> {
                    if (firstRun) {
                        prefs.edit().putString(KEY_URL, DEFAULT_URL).apply();
                        web.loadUrl(DEFAULT_URL);
                    }
                })
                .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Change server");
        menu.add(0, 2, 0, "Reload");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            askServerUrl(prefs.getString(KEY_URL, DEFAULT_URL), false);
            return true;
        }
        if (item.getItemId() == 2) { web.reload(); return true; }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
