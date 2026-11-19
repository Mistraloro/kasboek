Kasboek spike C: the Rust PDF reader, built by GitHub Actions for this computer.

Your own PDFs (nothing leaves this computer, nothing is written, no text is printed):
  Windows: drag the folder with your PDFs onto check-pdfs.cmd (or run it with the folder as argument).
  Mac / Linux: ./check-pdfs.sh /path/to/folder
Each file gets one line: ok or CHECK, number of pages, text pieces, pages without text (a scan or a picture),
pages with very little text, characters that could not be read, and the time. "ERROR import.pdf_scanned" means no
text at all; "ERROR import.pdf_broken" means the file could not be read; "NO ANSWER" would be a crash (please report).
Reply with the last line and the lines that say CHECK or ERROR, but remove or change the file names if they are private.

Comparing with the pdf.js reader of the real app (needs the repository and Node; the text of your PDFs is written
to the WORK folder, delete it afterwards):
  WORK=/some/empty/dir PDF_DIR=/folder/with/your/pdfs rust/spike/pdf/tools/run-all.sh
(the full list of steps is in rust/spike/pdf/README.md, "Rerun").

Everything in the CI run (corpus of invented PDFs, hostile files) is already tested for you; see the run summary.
