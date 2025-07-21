type Foo {
    enum_prop: Endian;
}




type          : keyword.declaration.edgeql, source.edgeql
 Foo          : source.edgeql
{             : punctuation.parenthesis.begin.edgeql, source.edgeql
              : source.edgeql
enum_prop     : source.edgeql
:             : punctuation.declaration.delimiter.edgeql, source.edgeql
              : source.edgeql
Endian        : source.edgeql, support.type.builtin.edgeql
;             : punctuation.statement.delimiter.edgeql, source.edgeql
}             : punctuation.parenthesis.end.edgeql, source.edgeql
