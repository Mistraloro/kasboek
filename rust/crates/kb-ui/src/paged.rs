//! `PagedModel`: a Slint `Model` over a source that is asked for 200 rows at a time. Only the rows in view are ever read
//! (the virtualised `ListView` calls `row_data` for them), the last ten pages stay in memory, and `invalidate` (the
//! page's `on_data_changed`) forgets them all and tells the view to read again.
use slint::{Model, ModelNotify, ModelRc, ModelTracker};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

/// Rows per page.
pub const PAGE_SIZE: usize = 200;
/// Pages kept (least recently used goes first).
pub const MAX_PAGES: usize = 10;

/// Where the rows come from (a query on the core service, or a fake in tests). Called on the UI thread, so keep
/// `fetch` to one indexed query of `count` rows.
pub trait PageSource<T> {
    /// Rows in total.
    fn row_count(&self) -> usize;
    /// Rows `start..start + count` (fewer at the end).
    fn fetch(&self, start: usize, count: usize) -> Vec<T>;
}

struct Cache<T> {
    rows: usize,
    pages: HashMap<usize, Rc<[T]>>,
    /// Page numbers, least recently used first.
    recent: VecDeque<usize>,
    fetches: u64,
}

pub struct PagedModel<T: Clone + 'static> {
    source: Box<dyn PageSource<T>>,
    cache: RefCell<Cache<T>>,
    notify: ModelNotify,
}

impl<T: Clone + 'static> PagedModel<T> {
    pub fn new(source: impl PageSource<T> + 'static) -> Self {
        let rows = source.row_count();
        Self {
            source: Box::new(source),
            cache: RefCell::new(Cache { rows, pages: HashMap::new(), recent: VecDeque::new(), fetches: 0 }),
            notify: ModelNotify::default(),
        }
    }

    /// For `ui.set_rows(...)`.
    pub fn to_model_rc(self: &Rc<Self>) -> ModelRc<T> {
        ModelRc::from(self.clone())
    }

    /// The data changed: forgets every page, asks the source for the new row count and resets the view.
    pub fn invalidate(&self) {
        {
            let mut cache = self.cache.borrow_mut();
            cache.pages.clear();
            cache.recent.clear();
            cache.rows = self.source.row_count();
        }
        self.notify.reset();
    }

    /// How many pages were read from the source so far.
    pub fn fetches(&self) -> u64 {
        self.cache.borrow().fetches
    }

    /// Pages in memory.
    pub fn cached_pages(&self) -> usize {
        self.cache.borrow().pages.len()
    }
}

impl<T: Clone + 'static> Model for PagedModel<T> {
    type Data = T;

    fn row_count(&self) -> usize {
        self.cache.borrow().rows
    }

    fn row_data(&self, row: usize) -> Option<T> {
        let page_no = row / PAGE_SIZE;
        {
            let mut cache = self.cache.borrow_mut();
            if row >= cache.rows {
                return None;
            }
            if let Some(page) = cache.pages.get(&page_no).cloned() {
                if cache.recent.back() != Some(&page_no) {
                    cache.recent.retain(|p| *p != page_no);
                    cache.recent.push_back(page_no);
                }
                return page.get(row % PAGE_SIZE).cloned();
            }
        }
        // Not in memory: read it without holding the borrow, so a source may look at the model.
        let start = page_no * PAGE_SIZE;
        let count = PAGE_SIZE.min(self.cache.borrow().rows - start);
        let page: Rc<[T]> = self.source.fetch(start, count).into();
        let mut cache = self.cache.borrow_mut();
        cache.fetches += 1;
        if cache.pages.len() >= MAX_PAGES {
            if let Some(oldest) = cache.recent.pop_front() {
                cache.pages.remove(&oldest);
            }
        }
        cache.pages.insert(page_no, page.clone());
        cache.recent.push_back(page_no);
        page.get(row % PAGE_SIZE).cloned()
    }

    fn model_tracker(&self) -> &dyn ModelTracker {
        &self.notify
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Numbers {
        rows: Rc<Cell<usize>>,
        asked: Rc<Cell<usize>>,
    }

    impl PageSource<usize> for Numbers {
        fn row_count(&self) -> usize {
            self.rows.get()
        }
        fn fetch(&self, start: usize, count: usize) -> Vec<usize> {
            self.asked.set(self.asked.get() + 1);
            (start..(start + count).min(self.rows.get())).collect()
        }
    }

    fn model(rows: usize) -> (PagedModel<usize>, Rc<Cell<usize>>, Rc<Cell<usize>>) {
        let (rows, asked) = (Rc::new(Cell::new(rows)), Rc::new(Cell::new(0)));
        (PagedModel::new(Numbers { rows: rows.clone(), asked: asked.clone() }), rows, asked)
    }

    #[test]
    fn reads_a_page_once() {
        let (m, _, asked) = model(1_000);
        assert_eq!(m.row_count(), 1_000);
        assert_eq!(m.row_data(0), Some(0));
        assert_eq!(m.row_data(199), Some(199));
        assert_eq!(m.row_data(200), Some(200));
        assert_eq!(m.row_data(999), Some(999));
        assert_eq!(m.row_data(1_000), None);
        assert_eq!(asked.get(), 3);
        assert_eq!(m.fetches(), 3);
    }

    #[test]
    fn last_page_is_short() {
        let (m, _, _) = model(250);
        assert_eq!(m.row_data(249), Some(249));
        assert_eq!(m.row_data(250), None);
    }

    #[test]
    fn keeps_ten_pages_and_drops_the_least_recently_used() {
        let (m, _, asked) = model(100 * PAGE_SIZE);
        for page in 0..MAX_PAGES {
            m.row_data(page * PAGE_SIZE);
        }
        assert_eq!((asked.get(), m.cached_pages()), (10, 10));
        // Page 0 is used again, so page 1 is the oldest and goes when page 10 comes in.
        m.row_data(0);
        m.row_data(10 * PAGE_SIZE);
        assert_eq!((asked.get(), m.cached_pages()), (11, 10));
        m.row_data(0);
        assert_eq!(asked.get(), 11, "page 0 stayed");
        m.row_data(PAGE_SIZE);
        assert_eq!(asked.get(), 12, "page 1 was dropped");
    }

    #[test]
    fn invalidate_forgets_pages_and_takes_the_new_row_count() {
        let (m, rows, asked) = model(500);
        assert_eq!(m.row_data(450), Some(450));
        rows.set(300);
        m.invalidate();
        assert_eq!((m.row_count(), m.cached_pages()), (300, 0));
        assert_eq!(m.row_data(450), None);
        assert_eq!(m.row_data(250), Some(250));
        assert_eq!(asked.get(), 2);
    }
}
