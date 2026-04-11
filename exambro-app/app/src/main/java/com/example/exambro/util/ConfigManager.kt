package com.example.exambro.util

import android.content.Context
import android.content.SharedPreferences
import com.example.exambro.data.RemoteVersion
import com.google.gson.Gson
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File

object ConfigManager {
    private const val PREFS_NAME = "exambro_prefs"
    private const val KEY_VERSION = "local_version"
    private const val CONFIG_FILE = "config.json"
    private const val VERSION_FILE = "version.json"

    private val client = OkHttpClient()
    private val gson = Gson()

    private fun getPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getLocalVersion(context: Context): String? =
        getPrefs(context).getString(KEY_VERSION, null)

    fun saveLocalVersion(context: Context, version: String) {
        getPrefs(context).edit().putString(KEY_VERSION, version).apply()
    }

    fun readLocalFile(context: Context, name: String): String? {
        val file = File(context.filesDir, name)
        return if (file.exists()) file.readText(Charsets.UTF_8) else null
    }

    fun writeLocalFile(context: Context, name: String, content: String) {
        File(context.filesDir, name).writeText(content, Charsets.UTF_8)
    }

    private fun fetchJson(url: String): String? {
        val request = Request.Builder()
            .url(url)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            return response.body?.string()
        }
    }

    fun fetchRemoteVersion(apiKey: String): RemoteVersion? {
        val url = "https://api.belajar2026.net/api/exambro/version.json?apikey=$apiKey"
        val json = fetchJson(url) ?: return null
        return gson.fromJson(json, RemoteVersion::class.java)
    }

    fun loadConfig(context: Context, apiKey: String): String? {
        val localVersion = getLocalVersion(context)
        val remoteVersion = fetchRemoteVersion(apiKey) ?: return readLocalFile(context, CONFIG_FILE)

        if (remoteVersion.config_version == localVersion) {
            return readLocalFile(context, CONFIG_FILE)
        }

        val configUrl = if (remoteVersion.config_url.contains("apikey=")) {
            remoteVersion.config_url
        } else {
            remoteVersion.config_url_with_apikey
        }

        val configJson = fetchJson(configUrl) ?: return readLocalFile(context, CONFIG_FILE)
        writeLocalFile(context, CONFIG_FILE, configJson)
        writeLocalFile(context, VERSION_FILE, gson.toJson(remoteVersion))
        saveLocalVersion(context, remoteVersion.config_version)
        return configJson
    }
}
