package com.despatch.mobile

import android.app.Activity
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Reports a foldable's hinge to the web app (PLAN.md §4.9), so the list and
 * reading panes can split along it. Positions are in CSS pixels relative to
 * the window; the WebView fills the window (edge-to-edge).
 */
class FoldWatcher(private val activity: Activity, private val onChange: (String) -> Unit) {
    private var job: Job? = null

    fun start() {
        if (job != null) return
        job = CoroutineScope(Dispatchers.Main).launch {
            WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { onChange(describe(it)) }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun describe(info: WindowLayoutInfo): String {
        val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
            ?: return JSONObject().put("fold", JSONObject.NULL).toString()
        val density = activity.resources.displayMetrics.density
        val bounds = fold.bounds
        return JSONObject().put(
            "fold",
            JSONObject()
                .put("orientation", if (fold.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal")
                .put("state", if (fold.state == FoldingFeature.State.HALF_OPENED) "half-opened" else "flat")
                .put("separating", fold.isSeparating)
                .put("left", bounds.left / density)
                .put("top", bounds.top / density)
                .put("right", bounds.right / density)
                .put("bottom", bounds.bottom / density),
        ).toString()
    }
}
