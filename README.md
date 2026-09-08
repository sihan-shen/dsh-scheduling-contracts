# `@han_05/dsh-scheduling-contracts`

Versioned scheduling contracts shared by the optional DSH scheduler and
orchestrator plugins.

当前开发重点在dsh-code-intelligence项目，其他项目迭代暂停。

- Parent repository: [DSH-Plugins](https://github.com/sihan-shen/DS-Plugins)
- Version: `0.3.0`
- Availability: prepared as a public npm dependency; publish it before
  installing `dsh-adaptive-scheduler` or `dsh-orchestrator` outside the parent
  repository.

This package contains schemas, validators, and bounded scheduling data types.
It does not mount a Cordis plugin or perform provider/network operations.
