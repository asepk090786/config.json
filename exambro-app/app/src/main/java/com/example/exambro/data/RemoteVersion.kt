package com.example.exambro.data

data class RemoteVersion(
    val config_version: String,
    val config_url: String,
    val config_url_versioned: String,
    val last_updated: String,
    val timestamp: Long,
    val min_app_version: String,
    val message: String,
    val config_hash: String
)
