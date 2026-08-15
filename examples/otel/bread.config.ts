import { defineConfig } from '@breadai/core'
import { otel } from '@breadai/otel'
import { providerCatalog } from '@breadai/provider-catalog'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'

// Register a tracer provider so the plugin's spans go somewhere visible —
// here the console; in production swap the exporter for OTLP.
new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
}).register()

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
  plugins: [otel({ serviceName: 'bread-otel-example' })],
})
