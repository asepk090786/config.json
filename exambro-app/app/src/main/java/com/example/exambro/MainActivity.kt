package com.example.exambro

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.exambro.data.RemoteVersion
import com.example.exambro.util.ConfigManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private val apiKey = "v5lzVwDIHIKw7ZgbfXOyHG7b0yOUqqpP"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val statusText = findViewById<TextView>(R.id.statusText)
        val contentText = findViewById<TextView>(R.id.contentText)

        lifecycleScope.launch(Dispatchers.IO) {
            val result = ConfigManager.loadConfig(this@MainActivity, apiKey)
            withContext(Dispatchers.Main) {
                if (result != null) {
                    statusText.text = "Config loaded successfully"
                    contentText.text = result
                } else {
                    statusText.text = "Failed to load config"
                    contentText.text = ""
                }
            }
        }
    }
}
