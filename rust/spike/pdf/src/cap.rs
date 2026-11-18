//! A memory cap for the reader process. hayro decodes a stream completely before it reads it and has no limit on the
//! size, so a few MB of deflate can ask for many GB (a decompression bomb). Past the cap the process answers
//! import.pdf_too_large and ends, instead of growing until the system kills something else. The app's reader runs in a
//! process of its own, so ending it is cheap (see src/main/pdf/run.ts).
use crate::model::ReadError;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

/// Live heap bytes the reader may use. A statement of 70 pages needs about 10 MB.
pub const CAP_BYTES: usize = 1 << 30;

pub struct Capped;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static TRIPPED: AtomicBool = AtomicBool::new(false);

#[cold]
fn trip() -> ! {
    // Allocations made while answering are let through.
    if !TRIPPED.swap(true, Relaxed) {
        println!("{{\"error\":\"{}\"}}", ReadError::TooLarge.code());
        std::process::exit(0);
    }
    loop {
        std::thread::park();
    }
}

unsafe impl GlobalAlloc for Capped {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if !TRIPPED.load(Relaxed) && LIVE.fetch_add(l.size(), Relaxed) + l.size() > CAP_BYTES {
            trip();
        }
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        if !TRIPPED.load(Relaxed) && LIVE.fetch_add(l.size(), Relaxed) + l.size() > CAP_BYTES {
            trip();
        }
        System.alloc_zeroed(l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if new > l.size() {
            if !TRIPPED.load(Relaxed)
                && LIVE.fetch_add(new - l.size(), Relaxed) + (new - l.size()) > CAP_BYTES
            {
                trip();
            }
        } else {
            LIVE.fetch_sub(l.size() - new, Relaxed);
        }
        System.realloc(p, l, new)
    }
}
