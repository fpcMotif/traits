import { Array, Effect, Hash, Option, Result, Schema as S } from "effect"
import { LanguageModel, Tool } from "effect/ai"

export type GenerationStage = typeof GenerationStage.Type
export const GenerationStage = S.Literals(["decompose", "reconcile"])

export type GenerationRequest = typeof GenerationRequest.Type
export const GenerationRequest = S.Struct({
  id: S.String,
  stage: GenerationStage,
  instructions: S.String,
  input: S.String,
  jsonSchema: S.Unknown
})

export type GeneratedOutput = typeof GeneratedOutput.Type
export const GeneratedOutput = S.Struct({
  id: S.String.annotate({ description: "The id of the GenerationRequired request this output answers." }),
  output: S.Unknown.annotate({ description: "A JSON object that matches the request's jsonSchema." })
})

export class GenerationPending extends S.TaggedError<GenerationPending>()("GenerationPending", {
  requests: S.Array(GenerationRequest)
}) {}

export class GeneratedOutputError extends S.TaggedError<GeneratedOutputError>()("GeneratedOutputError", {
  id: S.String,
  stage: GenerationStage,
  issue: S.String
}) {
  override get message() {
    return `Generated output ${this.id} for stage ${this.stage} does not match its schema: ${this.issue}`
  }
}

const requestId = (stage: GenerationStage, instructions: string, input: string) =>
  `${stage}-${(Hash.string(`${instructions}\n${input}`) >>> 0).toString(16)}`

export const generateObject = Effect.fn("Generation.generateObject")(function* <
  A,
  I extends Record<string, any>
>(options: {
  readonly stage: GenerationStage
  readonly instructions: string
  readonly input: string
  readonly schema: S.Codec<A, I>
  readonly generated: ReadonlyArray<GeneratedOutput>
}) {
  const model = yield* Effect.serviceOption(LanguageModel.LanguageModel)
  if (Option.isSome(model)) {
    const response = yield* LanguageModel.generateObject({
      prompt: [
        { role: "system", content: options.instructions },
        { role: "user", content: [{ type: "text", text: options.input }] }
      ],
      schema: options.schema
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model.value))
    return response.value
  }
  const id = requestId(options.stage, options.instructions, options.input)
  const supplied = Array.findFirst(options.generated, (generated) => generated.id === id)
  if (Option.isNone(supplied)) {
    return yield* GenerationPending.make({
      requests: [
        {
          id,
          stage: options.stage,
          instructions: options.instructions,
          input: options.input,
          jsonSchema: Tool.getJsonSchemaFromSchema(options.schema)
        }
      ]
    })
  }
  return yield* S.decodeUnknownEffect(options.schema)(supplied.value.output).pipe(
    Effect.mapError((error) => GeneratedOutputError.make({ id, stage: options.stage, issue: error.message }))
  )
})

export const all = Effect.fn("Generation.all")(function* <A, E, R>(
  effects: ReadonlyArray<Effect.Effect<A, E | GenerationPending, R>>
) {
  const results = yield* Effect.forEach(effects, Effect.result, { concurrency: "unbounded" })
  const values: Array<A> = []
  const requests = new Map<string, GenerationRequest>()
  for (const result of results) {
    if (Result.isSuccess(result)) values.push(result.success)
    else if (S.is(GenerationPending)(result.failure)) {
      for (const request of result.failure.requests) requests.set(request.id, request)
    } else return yield* Effect.fail(result.failure)
  }
  if (requests.size > 0) return yield* GenerationPending.make({ requests: Array.fromIterable(requests.values()) })
  return values
})
