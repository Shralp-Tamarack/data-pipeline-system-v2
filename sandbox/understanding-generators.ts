function* simpleGenerator() {
    yield 1
    yield 2;
    yield 3;
}

const genob1 = simpleGenerator();
const genob2 = simpleGenerator();

function gentest1() {
    console.log("gen test 1", genob1.next())
    console.log("gen test 1", genob1.next())
    console.log("gen test 1", genob1.next())
    console.log("gen test 1", genob1.next())
}
gentest1()
function gentest2() {
    console.log("gen test 2", genob2.next())
}
gentest2()