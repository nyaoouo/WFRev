"use strict"

const fs = require("node:fs")

const [previousName, nextName, ...files] = process.argv.slice(2)
if (!previousName || !nextName || files.length === 0) {
    throw new Error("Expected the old and new ELF names and at least one file")
}
const original = Buffer.from(previousName + "\0")
const replacement = Buffer.from(nextName + "\0")
if (original.length !== replacement.length) throw new Error("ELF name lengths must match")
for (const file of files) {
    const contents = fs.readFileSync(file)
    let offset = contents.indexOf(original)
    if (offset < 0) throw new Error("Could not find " + previousName + " in " + file)
    do {
        replacement.copy(contents, offset)
        offset = contents.indexOf(original, offset + original.length)
    } while (offset !== -1)
    fs.writeFileSync(file, contents)
}
