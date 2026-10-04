# decision

Pipeline `classify` asks a decision host which desk owns the message, then the `reply` agent answers that same message.

The agent still receives the original string. The label is on the decision step-end crumb: `pipeline:step:end` `output` is `{ label, answer }`.

`bread build` loads this config and does not call a host.

```bash
curl -N -X POST localhost:3000/pipelines/classify/run \
  -d '{"input":"TICKET-8841 refund the duplicate charge"}'
```
