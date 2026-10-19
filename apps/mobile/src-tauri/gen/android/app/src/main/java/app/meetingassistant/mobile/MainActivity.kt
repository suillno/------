package app.meetingassistant.mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import org.json.JSONObject

/**
 * 다른 앱(Joplin 등)의 '공유 → 회의 어시스턴트'를 받는다. docs/plans/2026-10-19-meeting-features.md 5장.
 *
 * - 받은 텍스트는 SharedPreferences에 보관한다(앱 종료·로그인 전에도 유지).
 * - 화면(JS)은 WebView 브리지 MeetingAssistantShare.take()로 한 번 꺼내 작성 중 초안으로 옮긴다. 꺼내면 지운다.
 * - 텍스트·Markdown만 다룬다. 파일로 오면 text 계열 MIME 또는 .md/.txt만 읽고(1MB 제한), 이미지·첨부는 안내만 한다.
 * - 저장·분석은 하지 않는다. 사용자가 작성 화면에서 확인한 뒤 '저장'을 눌러야 저장된다.
 * - 로그에는 내용 없이 전달 형식(종류·길이)만 남긴다.
 */
class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 화면 회전 등으로 다시 만들어질 때는 같은 공유를 두 번 담지 않는다
    if (savedInstanceState == null) storeShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (storeShare(intent)) {
      webViewRef?.post {
        webViewRef?.evaluateJavascript("window.dispatchEvent(new Event('meeting-assistant:share'))", null)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    webView.addJavascriptInterface(ShareBridge(), BRIDGE_NAME)
  }

  /** JS에 공개하는 메서드는 take() 하나뿐이다(보관된 공유 JSON을 돌려주고 지운다). */
  inner class ShareBridge {
    @JavascriptInterface
    fun take(): String {
      val prefs = prefs()
      val value = prefs.getString(KEY_PENDING, "") ?: ""
      prefs.edit().remove(KEY_PENDING).apply()
      return value
    }
  }

  private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

  private fun storeShare(intent: Intent?): Boolean {
    if (intent?.action != Intent.ACTION_SEND) return false
    val type = intent.type ?: ""
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE)
    var text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    var title = subject
    var unsupported: String? = null
    val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)

    if (text.isNullOrBlank() && stream != null) {
      val name = displayName(stream)
      val streamType = contentResolver.getType(stream) ?: type
      val isText = streamType.startsWith("text/") || name?.lowercase()?.let { it.endsWith(".md") || it.endsWith(".txt") } == true
      if (isText) {
        text = readText(stream)
        if (title.isNullOrBlank() && name != null) title = name.substringBeforeLast('.')
        if (text == null) unsupported = "파일을 읽을 수 없거나 1MB보다 큽니다."
      } else {
        unsupported = "텍스트·Markdown만 가져올 수 있습니다(이미지·첨부파일 제외)."
      }
    } else if (text.isNullOrBlank()) {
      unsupported = "가져올 텍스트가 없습니다."
    }

    // 형식 확인용 로그: 내용 없이 종류·길이만
    Log.i(TAG, "share type=$type subject=${subject?.length ?: -1} text=${text?.length ?: -1} stream=${stream != null}")

    val json = JSONObject()
      .put("title", title ?: JSONObject.NULL)
      .put("text", text ?: JSONObject.NULL)
      .put("unsupported", unsupported ?: JSONObject.NULL)
    prefs().edit().putString(KEY_PENDING, json.toString()).apply()
    return true
  }

  private fun displayName(uri: Uri): String? = try {
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  /** UTF-8 텍스트를 최대 1MB까지 읽는다. 더 크면 null. */
  private fun readText(uri: Uri): String? = try {
    contentResolver.openInputStream(uri)?.use { input ->
      val buffer = java.io.ByteArrayOutputStream()
      val chunk = ByteArray(8192)
      var total = 0
      while (true) {
        val n = input.read(chunk)
        if (n < 0) break
        total += n
        if (total > MAX_BYTES) return null
        buffer.write(chunk, 0, n)
      }
      buffer.toString("UTF-8")
    }
  } catch (e: Exception) {
    null
  }

  companion object {
    private const val TAG = "MeetingAssistantShare"
    private const val BRIDGE_NAME = "MeetingAssistantShare"
    private const val PREFS = "meeting-assistant-share"
    private const val KEY_PENDING = "pending"
    private const val MAX_BYTES = 1_000_000
  }
}
