The code graph is built and kept fresh for you. To locate or understand code, call graph_find (source: true), graph_callers or graph_file_api first and read only the spans they return; grep is for literal text. If a graph tool says it is still building, grep meanwhile and retry.
<!-- harness -->
MendCode builds and refreshes the graph, so never skip it for lack of one; if it says it is still building, search text meanwhile and retry. Read only the file:line spans it returns.
