// Acceptance checks stay outside the model workspace and are identical per policy.
export const benchmarkCases = [
  {
    id: "parse-port",
    files: {
      "port.mjs":
        "export function parsePort(value) { return Number(value) || 3000; }\n",
    },
    prompt:
      "Fix port.mjs. parsePort(undefined) returns 3000; accept integers 0 through 65535 and their nonempty decimal digit strings. Reject every other value with RangeError. Preserve the named export. Do not add dependencies. Inspect and edit only port.mjs. Finish when implemented.",
    check: `const {parsePort} = await import(target); for (const [v,e] of [[undefined,3000],[0,0],[65535,65535],["0",0],["8080",8080]]) assert.equal(parsePort(v),e); for(const v of [null,"", " ", -1,65536,1.5,"1.5",true,NaN,Infinity,[],{}]) assert.throws(()=>parsePort(v),RangeError);`,
    target: "port.mjs",
  },
  {
    id: "deduplicate",
    files: {
      "unique.mjs": "export function uniqueById(rows) { return rows; }\n",
    },
    prompt:
      "Implement uniqueById(rows) in unique.mjs. Return a new array retaining the first row for each id, in original order. IDs are strings or numbers and use JavaScript Map equality; numeric 1 and string '1' differ. Do not mutate input rows or the input array. Preserve object identity for retained rows. Empty input returns a new empty array. No dependencies; inspect and edit only unique.mjs.",
    check: `const {uniqueById}=await import(target); const a=Object.freeze({id:1}),b=Object.freeze({id:"1"}),c=Object.freeze({id:1}),d=Object.freeze({id:"__proto__"});const rows=Object.freeze([a,b,c,d,d]); const out=uniqueById(rows);assert.deepEqual(out,[a,b,d]);assert.notEqual(out,rows);assert.equal(out[0],a);const empty=Object.freeze([]);assert.deepEqual(uniqueById(empty),[]);assert.notEqual(uniqueById(empty),empty);`,
    target: "unique.mjs",
  },
  {
    id: "retry",
    files: {
      "retry.mjs":
        "export async function retry(operation, attempts) { return operation(); }\n",
    },
    prompt:
      "Implement retry(operation, attempts) in retry.mjs. attempts must be an integer from 1 through 5, otherwise throw RangeError without calling operation. Call operation with its 1-based attempt number. Return the first fulfilled value, including undefined or false. Retry synchronous throws and rejected promises up to the limit, then throw the exact last error object. Calls must be sequential; no delay or dependencies. Inspect and edit only retry.mjs.",
    check: `const {retry}=await import(target);let calls=[];assert.equal(await retry(n=>{calls.push(n);if(n<3)throw new Error("again");return false;},3),false);assert.deepEqual(calls,[1,2,3]);let errors=[new Error("one"),new Error("two")];let n=0;await assert.rejects(()=>retry(async()=>{throw errors[n++];},2),e=>e===errors[1]);assert.equal(n,2);let zero=0;for(const v of [0,6,1.5,"2",null,undefined])await assert.rejects(()=>retry(()=>zero++,v),RangeError);assert.equal(zero,0);assert.equal(await retry(()=>undefined,1),undefined);`,
    target: "retry.mjs",
  },
];
