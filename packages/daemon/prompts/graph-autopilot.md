The code graph is built and kept fresh for you. To locate or understand code, call graph_find (source: true), graph_callers or graph_file_api first and read only the spans they return; grep is for literal text. If a graph tool says it is still building, grep meanwhile and retry.
<!-- harness -->
MendCode builds and refreshes this graph itself, so a missing graph is never a reason to skip it. If a graph tool answers that it is still building, use text search meanwhile and call it again later. Read only the file:line spans it returns.
