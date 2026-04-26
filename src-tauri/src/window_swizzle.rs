/// Method swizzle on `NSThemeFrame.layout` to keep traffic-light buttons in their
/// custom position on every layout pass.
///
/// AppKit calls `-[NSThemeFrame layout]` whenever the title bar needs to lay out:
/// startup, resize, fullscreen toggle, title change, theme change, etc. By
/// swizzling this method we can run our positioning code *after* AppKit's own
/// layout, ensuring our positions always win regardless of what triggered the
/// layout. This is the same mechanism used by INAppStoreWindow and BSAppStoreWindow.
///
/// Uses Apple private API (`NSThemeFrame` is undocumented). Guarded to only
/// apply to windows with the `FullSizeContentView` style mask (our overlay
/// windows), so system dialogs and panels are unaffected.

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Once;

pub static TRAFFIC_X: AtomicI32 = AtomicI32::new(14);
pub static TRAFFIC_Y: AtomicI32 = AtomicI32::new(19);

static INSTALL_ONCE: Once = Once::new();

/// Install the swizzle. Idempotent — safe to call multiple times.
/// Must be called from the main thread before any window is shown.
pub unsafe fn install() {
    INSTALL_ONCE.call_once(|| {
        if let Err(e) = install_inner() {
            tracing::warn!("Failed to install NSThemeFrame.layout swizzle: {}", e);
        } else {
            tracing::info!("Installed NSThemeFrame.layout swizzle");
        }
    });
}

unsafe fn install_inner() -> Result<(), &'static str> {
    use objc2::ffi::{
        class_addMethod, class_getInstanceMethod, method_exchangeImplementations,
    };
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::sel;

    let theme_frame_cls = AnyClass::get(c"NSThemeFrame").ok_or("NSThemeFrame class not found")?;
    let cls_ptr = theme_frame_cls as *const AnyClass as *mut _;

    let original_sel = sel!(layout);
    let new_sel = sel!(splice_swizzledLayout);

    extern "C" fn replaced_layout(this: *mut AnyObject, _cmd: Sel) {
        unsafe {
            use objc2::msg_send;

            // Call the original layout (now reachable under splice_swizzledLayout)
            let _: () = msg_send![this, splice_swizzledLayout];

            // Get the window. NSThemeFrame.window returns the NSWindow it belongs to.
            let window: *mut AnyObject = msg_send![this, window];
            if window.is_null() {
                return;
            }

            // Only customize windows with FullSizeContentView (our overlay style).
            // Standard alerts/dialogs/panels don't have this bit set.
            const NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW: u64 = 1 << 15;
            let style_mask: u64 = msg_send![window, styleMask];
            if style_mask & NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW == 0 {
                return;
            }

            position_traffic_lights(window as *mut std::ffi::c_void);
        }
    }

    // Add our IMP under a new selector. Type encoding `v@:` = void return, self id, SEL.
    let new_imp = std::mem::transmute::<
        extern "C" fn(*mut AnyObject, Sel),
        objc2::runtime::Imp,
    >(replaced_layout);
    let added = class_addMethod(cls_ptr, new_sel, new_imp, c"v@:".as_ptr());
    if !added.as_bool() {
        return Err("Failed to add splice_swizzledLayout method");
    }

    // Now exchange `layout` and `splice_swizzledLayout`.
    // After exchange:
    //   - sending `layout` to NSThemeFrame instance → our replaced_layout
    //   - sending `splice_swizzledLayout` → AppKit's original layout IMP
    let original_method = class_getInstanceMethod(cls_ptr, original_sel);
    let new_method = class_getInstanceMethod(cls_ptr, new_sel);
    if original_method.is_null() || new_method.is_null() {
        return Err("Failed to retrieve methods for exchange");
    }
    method_exchangeImplementations(original_method as *mut _, new_method as *mut _);

    Ok(())
}

/// Position the traffic-light buttons at the current TRAFFIC_X / TRAFFIC_Y values.
unsafe fn position_traffic_lights(ns_window: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    if ns_window.is_null() {
        return;
    }
    let win: &NSWindow = &*(ns_window as *const NSWindow);

    let x = TRAFFIC_X.load(Ordering::Relaxed) as f64;
    let y = TRAFFIC_Y.load(Ordering::Relaxed) as f64;

    let Some(close) = win.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(mini) = win.standardWindowButton(NSWindowButton::MiniaturizeButton) else { return };
    let zoom = win.standardWindowButton(NSWindowButton::ZoomButton);

    let Some(container) = close.superview().and_then(|v| v.superview()) else { return };

    let close_rect = NSView::frame(&close);
    let button_height = close_rect.size.height;

    // Resize the NSTitlebarContainerView to make room for our offset.
    let bar_height = button_height + y;
    let mut bar_rect = NSView::frame(&container);
    bar_rect.size.height = bar_height;
    bar_rect.origin.y = NSWindow::frame(win).size.height - bar_height;
    container.setFrame(bar_rect);

    // Buttons: fixed 20-pt spacing, vertically centered in container.
    let space_between: f64 = 20.0;
    let vertical_offset: f64 = 4.0;

    let mut buttons = vec![close, mini];
    if let Some(z) = zoom {
        buttons.push(z);
    }
    for (i, btn) in buttons.into_iter().enumerate() {
        let mut r = NSView::frame(&btn);
        r.origin.x = x + (i as f64) * space_between;
        r.origin.y = ((bar_height - button_height) / 2.0) - vertical_offset;
        btn.setFrameOrigin(r.origin);
    }
}
