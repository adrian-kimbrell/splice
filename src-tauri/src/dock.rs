/// macOS dock right-click menu — "New Window"
///
/// Tauri 2.10 has no built-in dock-menu API, so we reach into the ObjC runtime:
///   1. Store the AppHandle in a global so the action handler can use it.
///   2. Define a helper ObjC class (`SpliceDockTarget`) whose sole method
///      `newWindowFromDock:` creates a new Splice window.
///   3. Add `applicationDockMenu:` to tao's `TaoAppDelegateParent` class,
///      returning a one-item NSMenu that invokes `newWindowFromDock:`.
use std::sync::OnceLock;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    unsafe { inject_dock_menu() };
}

unsafe fn inject_dock_menu() {
    use objc2::ffi::{class_addMethod, objc_registerClassPair, objc_allocateClassPair};
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::sel;
    use objc2_app_kit::{NSMenu, NSMenuItem};
    use objc2_foundation::NSString;
    use objc2::MainThreadMarker;


    // ── 1. Create the helper target class ────────────────────────────────────
    // (only register it once even if called multiple times, though in practice
    //  this runs exactly once during app startup)
    let target_class_name = c"SpliceDockTarget";
    let target_cls: *mut AnyClass = if let Some(cls) = AnyClass::get(target_class_name) {
        cls as *const _ as *mut _
    } else {
        let ns_object = AnyClass::get(c"NSObject").expect("NSObject must exist");
        let new_cls = objc_allocateClassPair(
            ns_object as *const _ as *mut _,
            target_class_name.as_ptr(),
            0,
        );
        assert!(!new_cls.is_null(), "Failed to allocate SpliceDockTarget class");

        // `newWindowFromDock:` — called when the user clicks "New Window" in the dock menu
        extern "C" fn new_window_from_dock(_self: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) {
            if let Some(app) = APP_HANDLE.get() {
                let label = format!(
                    "main-{:x}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                );
                let _ = crate::commands::workspace::register_window(label.clone());
                let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("/".into()))
                    .title("Splice")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .decorations(true)
                    .resizable(true)
                    .build();
            }
        }

        let added = class_addMethod(
            new_cls,
            sel!(newWindowFromDock:),
            std::mem::transmute::<extern "C" fn(*mut AnyObject, Sel, *mut AnyObject), objc2::runtime::Imp>(new_window_from_dock),
            c"v@:@".as_ptr(),
        );
        assert!(added.as_bool(), "Failed to add newWindowFromDock:");

        objc_registerClassPair(new_cls);
        new_cls
    };

    // ── 2. Build the dock NSMenu with one item ────────────────────────────────
    // We run this only on the main thread — setup() is called from the Tauri
    // setup closure which runs on the main thread.
    let mtm = MainThreadMarker::new_unchecked();
    let menu = NSMenu::new(mtm);

    // Allocate the shared target object (leaked — lives for the whole app lifetime)
    let target: *mut AnyObject = {
        use objc2::msg_send;
        let raw: *mut AnyObject = msg_send![target_cls as *const AnyClass, alloc];
        let raw: *mut AnyObject = msg_send![raw, init];
        raw
    };
    // Retain the target so ARC doesn't release it — it lives for the whole app lifetime.
    {
        use objc2::msg_send;
        let _: *mut AnyObject = msg_send![target, retain];
    }

    let title = NSString::from_str("New Window");
    let item = NSMenuItem::new(mtm);
    item.setTitle(&title);
    item.setAction(Some(sel!(newWindowFromDock:)));
    // setTarget: keep a strong reference via forget above
    {
        use objc2::msg_send;
        let _: () = msg_send![&*item, setTarget: target];
    }
    menu.addItem(&item);

    // Leak the menu — it must stay alive for the app's lifetime
    let menu_ptr: *const NSMenu = &*menu;
    std::mem::forget(menu);

    // ── 3. Add applicationDockMenu: to TaoAppDelegateParent ──────────────────
    let delegate_cls = AnyClass::get(c"TaoAppDelegateParent");
    if let Some(delegate_cls) = delegate_cls {
        extern "C" fn application_dock_menu(
            _self: *mut AnyObject,
            _cmd: Sel,
            _app: *mut AnyObject,
        ) -> *mut NSMenu {
            DOCK_MENU.load(std::sync::atomic::Ordering::Relaxed)
        }

        // Store the menu pointer for the C callback
        DOCK_MENU.store(menu_ptr as *mut _, std::sync::atomic::Ordering::Relaxed);

        class_addMethod(
            delegate_cls as *const _ as *mut _,
            sel!(applicationDockMenu:),
            std::mem::transmute::<extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut NSMenu, objc2::runtime::Imp>(application_dock_menu),
            c"@@:@".as_ptr(),
        );
    }
}

static DOCK_MENU: std::sync::atomic::AtomicPtr<objc2_app_kit::NSMenu> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());
