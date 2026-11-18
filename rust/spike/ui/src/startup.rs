//! Real window with start-up milestones in the style of startup.log.
use crate::{App, fixtures, strings::En};
use slint::ComponentHandle;
use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
use std::time::Instant;

struct Log {
    t0: Instant,
    lines: Vec<String>,
}

impl Log {
    fn mark(&mut self, what: &str) {
        let ms = self.t0.elapsed().as_secs_f64() * 1000.0;
        let line = format!("{ms:8.1} ms  {what}");
        // KASBOEK_STARTUP_TRACE=1: print each milestone as it happens (also shows where a start hangs).
        if std::env::var_os("KASBOEK_STARTUP_TRACE").is_some() {
            eprintln!("{line}");
        }
        self.lines.push(line);
    }
}

pub fn run(args: &[String]) {
    let log = Rc::new(RefCell::new(Log {
        t0: Instant::now(),
        lines: vec![],
    }));
    // Times are from `main`; the loader and runtime start-up before it are measured from outside (tools/startup-bench.sh).
    log.borrow_mut().mark("main entered");
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let screen = arg("--screen").unwrap_or_else(|| "lock-password".into());
    let dark = arg("--theme").as_deref() == Some("dark");
    let exit = args.iter().any(|a| a == "--exit-after-first-frame");

    let renderer = arg("--renderer").unwrap_or_else(|| "software".into());
    slint::BackendSelector::new()
        .backend_name("winit".into())
        .renderer_name(renderer.clone())
        .select()
        .expect("backend");
    log.borrow_mut()
        .mark(&format!("backend selected (renderer {renderer})"));

    let en = En::load();
    log.borrow_mut().mark("texts read (en.json)");
    let ui = App::new().expect("ui");
    fixtures::apply(&ui, &en, &screen, dark);
    log.borrow_mut().mark("window created");

    // First frame: the rendering notifier (GL renderers) or, for the software renderer, the first timer tick after show().
    let first = Rc::new(RefCell::new(false));
    let notifier_ok = {
        let (log, first, weak) = (log.clone(), first.clone(), ui.as_weak());
        ui.window()
            .set_rendering_notifier(move |state, _| {
                if matches!(state, slint::RenderingState::AfterRendering) && !*first.borrow() {
                    *first.borrow_mut() = true;
                    log.borrow_mut().mark("first frame painted");
                    if exit {
                        let _ = weak.upgrade_in_event_loop(|_| {});
                        let _ = slint::quit_event_loop();
                    }
                }
            })
            .is_ok()
    };
    ui.show().expect("show");
    log.borrow_mut().mark("window shown (show() returned)");
    if !notifier_ok {
        log.borrow_mut()
            .mark("rendering notifier unsupported by this renderer");
        let (log, weak) = (log.clone(), ui.as_weak());
        // Software renderer: this runs on the event loop after the first pass, which renders and presents.
        // The first redraw is handled before this timer fires, so this is an upper bound (+16 ms).
        slint::Timer::single_shot(std::time::Duration::from_millis(16), move || {
            log.borrow_mut().mark("first frame painted (software renderer has no hook: 16 ms timer after show, upper bound)");
            let _ = weak.upgrade();
            if exit {
                let _ = slint::quit_event_loop();
            }
        });
    }
    slint::run_event_loop().expect("event loop");
    log.borrow_mut().mark("event loop ended");
    let text = log.borrow().lines.join("\n");
    match arg("--log") {
        Some(path) => {
            let mut f = std::fs::File::create(path).expect("log file");
            writeln!(f, "{text}").ok();
        }
        None => println!("{text}"),
    }
}
