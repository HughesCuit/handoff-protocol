/**
 * Fixture for the comment-tag scanner unit tests.
 * Line numbers are asserted by tests/shared/unit-suite.mjs — edit with care.
 */
const asString = "TODO: plain string false positive";
const asTemplate = `FIXME: template literal false positive`;
// TODO: real line comment
/* FIXME: real block comment */
const markdownExample = `
# Usage

\`\`\`ts
// HACK: markdown example inside a template literal
\`\`\`
`;
console.log("Scanned: 3 TODO/FIXME items found"); // generated output text
/*
 * Multi-line block comment.
 * HACK: real tag on an inner block line
 */
// XXX: real xxx tag stays medium priority
const tricky = "/* not a comment */ TODO: inside string";
