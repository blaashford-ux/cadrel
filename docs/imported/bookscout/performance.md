# Performance

Measured with `test/perf.test.ts` on the build machine (a shared cloud VM; a desktop will be at least as fast). Synthetic library: 5,000 books, 25,000 snapshots, 20 categories with 12 list captures each, 150,000 text chunks.

| Operation | Time |
|---|---|
| Ingest one real book page (scrub, store, parse, index) | ~370 ms |
| Re-read (rebuild) one stored book page | ~220 ms (cheerio parse dominates), so 1,000 pages ≈ 4 minutes, shown with progress |
| List all 5,000 books | 37 ms |
| Category report (every analysis) | 77 ms |
| Success scores for a category | 12 ms |
| CSV export | 17 ms |
| Keyword search over 150,000 chunks | 230 ms |
| Hybrid (keyword + meaning) search over 30,000 vectors | 90 ms |
| Embed 30,000 chunks with the built-in basic embedder | 2.2 s |
| Check the library (integrity + files) | 0.6 s |
| Copy a library of ~1,500 files | seconds (progress shown; verified by file count and size) |

The real neural model will be slower to embed than the basic one (it was not run in the build environment); embedding happens in the background after captures and chunks already embedded are never recomputed, even across rebuilds.
