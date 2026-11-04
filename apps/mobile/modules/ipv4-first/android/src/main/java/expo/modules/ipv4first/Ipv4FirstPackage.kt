package expo.modules.ipv4first

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

// Expo autolinking finds this class because its file name ends in Package.kt, and runs the
// listener in Application.onCreate, before React Native or Glide builds an HTTP client.
//
// From then on every client OkHttpClientProvider.createClient() hands out tries IPv4 first.
// React Native's fetch and expo-image's thumbnail loads both take their client from there, and
// patches/expo-file-system@57.0.7.patch points expo-file-system's uploads at it too.
//
// The client leaves out the 10 MB HTTP cache React Native's fetch client had. expo-image's own
// client never had one, and on it a cache would keep image bytes on disk after logout clears
// expo-image's cache. Every API answer is no-store, so fetch loses nothing.
class Ipv4FirstPackage : Package {
  override fun createApplicationLifecycleListeners(
    context: Context,
  ): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          OkHttpClientProvider.setOkHttpClientFactory {
            OkHttpClientProvider.createClientBuilder().dns(Ipv4FirstDns).build()
          }
        }
      },
    )
}
