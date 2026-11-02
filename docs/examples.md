# Examples

[Back to the README](../README.md)

## The prompt

```
Go scan the developer.salesforce.com docs on the current release's governors and limits
```

The sample prompt is broad on purpose: I wanted to see the agent decide what "governors and limits" covers, and whether it could find everything in a broad question.

Here are the results of that prompt, one run each on Opus 5.5 and Sonnet 5.5 at effort high. Each session called sf-docs-agent, which returned quotes with their
official URLs, and the session turned them into the answer.

<details>
<summary><b>Sonnet 5.5, effort high, through the agent</b>: 86 seconds, 34k agent tokens</summary>
<br>

> The `sf-docs` agent finished scanning the Apex governors and limits pages. All limit values below are quoted from the cached concept page, `apex_gov_limits.htm`. The release version is an inference, not a stated fact.
>
> ## Which release
> - The cached pages are the unversioned "current" docs, and they don't name a release.
> - The version dropdown lists **Summer '26 (API 67.0, path `262.0`)** as the newest versioned link.
> - The page's own sidebar links point to `264.0` paths. That is most likely **Winter '27 (API 68.0)**.
> - The agent did not fetch the 262 or 264 versioned pages to confirm.
>
> ## Per-transaction Apex limits
> Limits are listed as synchronous / asynchronous.
>
> | Limit | Sync | Async |
> |---|---|---|
> | SOQL queries | 100 | 200 |
> | SOQL rows retrieved | 50,000 | 50,000 |
> | DML statements | 150 | 150 |
> | DML rows | 10,000 | 10,000 |
> | Callouts | 100 | 100 |
> | `@future` methods per invocation | 50 | 0 in batch and future contexts, 50 in queueable |
> | `System.enqueueJob` | 50 | 1 |
> | Heap | 10 MB | 25 MB |
> | CPU time | 10,000 ms | 60,000 ms |
> | Execution time | 10 minutes | 10 minutes |
>
> - **Enforcement:** "the Apex runtime engine strictly enforces limits", and exceeding a limit raises a runtime exception "that can't be handled."
> - **Reset and scope:** For Batch Apex, limits reset for each `execute` call. Synchronous limits apply to scheduled Apex. Bulk API transactions get the higher of the sync and async limits.
> - **Heap:** Exceeding it gives an uncatchable `System.LimitException`. Email services get a 50 MB heap.
>
> ## Certified managed packages
> - Each certified namespace gets its own per-transaction limits.
> - The cumulative limit across namespaces is 11 times the per-namespace limit. That gives 1,100 SOQL queries and 1,650 DML statements.
> - Heap, CPU, execution time and the unique-namespace count are not counted separately per package.
>
> ## Platform, static and size limits
> - **Async executions per 24 hours:** 250,000, or licenses × 200, whichever is greater.
> - **Concurrent long-running transactions (over 5 seconds):** one per 100 licenses.
> - **Scheduled classes:** 100 (5 in Developer Edition).
> - **Batch jobs queued or active:** 5.
> - **Callout timeout:** 10 seconds by default.
> - **Callout request or response size:** 6 MB synchronous, 12 MB asynchronous.
> - **Apex code per org:** 6 MB.
> - **Method size:** 65,535 bytecode instructions.
> - **Single email:** 5,000 external addresses per day per org (GMT).
> - **Push notifications:** 20,000 iOS and 10,000 Android per hour.
> - **Governor limit email warnings:** The default threshold is 50% of allocated limits, and only per-request limits are checked.
>
> ## Gaps
> - **Not fetched:** The agent did not read the "Elastic Limits for Asynchronous Apex Jobs (Beta)" page or `apex_limits_tips.htm`.
> - **Not quoted:** Several rows on the same page weren't quoted:
>   - push notification calls per transaction
>   - Apex cursor limits
>   - inbound email limits
>   - the 450,000 `MAX_DML_ROWS` limit in tests
> - **"Lightweight limits":** This isn't a section name in the docs.
>
> ## Sources
> - https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm
> - https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits_emails.htm
>
> The pages are cached locally, so you can check any quote with `grep -c -F '<quote>' <cache path>`. The cache is under `~/.claude/sf-docs/cache/developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/`.
>
> I can have the agent fetch the 262 and 264 versioned pages to pin down the release, or cover the elastic limits page.

</details>

<details>
<summary><b>Opus 5.5, effort high, through the agent</b>: 89 seconds, 39k agent tokens</summary>
<br>

> I read the Apex Developer Guide page **Execution Governors and Limits**. I spot-checked several of the quotes against the cached copy of the page and they match.
>
> **Which release:** the page doesn't name its release. Its links point to the 264.0 doc set, and its list of older versions starts at Summer '26 (API 67.0). So this is most likely **Winter '27 (API 68.0)**, but that's my inference, not something the page says. The page also doesn't mark any limit as new or changed in this release.
>
> ### Per-transaction Apex limits (synchronous / asynchronous)
> | Limit | Sync | Async |
> |---|---|---|
> | SOQL queries | 100 | 200 |
> | SOQL rows retrieved | 50,000 | 50,000 |
> | `Database.getQueryLocator` rows | 10,000 | 10,000 |
> | SOSL queries / rows per query | 20 / 2,000 | 20 / 2,000 |
> | DML statements / rows | 150 / 10,000 | 150 / 10,000 |
> | Trigger recursion stack depth | 16 | 16 |
> | Callouts / cumulative callout timeout | 100 / 120 s | 100 / 120 s |
> | `@future` calls | 50 | 0 in batch and future; 50 in queueable |
> | `System.enqueueJob` | 50 | 1 |
> | `sendEmail` calls | 10 | 10 |
> | Heap | 10 MB | 25 MB |
> | CPU time | 10,000 ms | 60,000 ms |
> | Maximum execution time | 10 min | 10 min |
> | `EventBus.publish` calls (publish immediately) | 150 | 150 |
> | Apex cursor rows / `Cursor.fetch` calls | 50M / 100 | 50M / 100 |
> | Pagination cursors: rows / instances / rows per page | 100,000 / 50 / 2,000 | same |
>
> **Notes that change how these apply:**
> - **Scheduled Apex** runs under the synchronous limits.
> - **Bulk API** transactions get the higher of the sync and async values.
> - **Parent-child subqueries** each count as an extra query.
> - **Custom metadata queries** don't count toward the SOQL limit.
> - **Email services** get a 50 MB heap.
> - **CPU time** leaves out time spent waiting on the database and on callouts.
> - **Batch Apex** limits reset for each `execute` chunk.
>
> ### Org-wide Platform limits
> - **Async executions per 24 hours:** 250,000 or 200 × licenses, whichever is greater. Batch Apex checks up front that the whole job fits under this limit before it starts.
> - **Elastic async executions (beta)** can add up to 2 million more per day.
> - **Cursors per 24 hours:** 10,000 cursor instances, 100M cursor rows, and 200,000 pagination cursors.
> - **Long-running synchronous transactions (over 5 s):** 1 per 100 licenses, minimum 10 and maximum 50.
> - **Scheduled classes:** 100 (5 in Developer Edition).
> - **Batch Apex:**
>   - Flex queue jobs in Holding status: 100
>   - Jobs queued or active: 5
>   - Concurrent `start` methods: 1
> - **Test classes queued per 24 hours:** the greater of 500 or 10× your test classes in production (20× in sandbox and Developer Edition).
>
> ### Static and size limits
> - **Callouts:** 10 s default timeout; request or response up to 6 MB sync or 12 MB async, and this counts toward heap.
> - **SOQL run time:** 120 s.
> - **Deployments:** 7,500 code units each.
> - **Trigger batch size:** 200, or 2,000 for platform events and Change Data Capture.
> - **`QueryLocator`:** 50M records.
> - **Code size:**
>   - 1M characters per class or trigger.
>   - 6 MB of Apex per org (10 MB in scratch orgs). Support can raise it, and managed-package and `@isTest` code don't count.
>   - 65,535 bytecode instructions per method.
>
> ### Certified managed packages
> - Each certified namespace gets its own copy of the per-transaction limits.
> - The total across namespaces is capped at 11× the per-namespace limit: for example, 1,100 SOQL queries or 1,650 DML statements.
> - Heap, CPU time, execution time and the number of namespaces are shared across the whole transaction.
> - Code in non-certified packages counts against your org's own limits.
>
> ### Other limits on the page
> - **Single email:** 5,000 external addresses per day and 150 recipients per message.
> - **Push notifications:** 20,000 iOS and 10,000 Android per hour per org.
> - **Tests:** 450,000 DML rows per synchronous test run.
> - **ConnectApi:** each write costs one DML statement.
> - **Data.com Clean:** 200 SOQL queries and 10 future calls per batch.
>
> **Not covered:** I didn't read the Asynchronous Callout Limits page or the Winter '27 release notes. If you need to know what changed since Summer '26, the release notes are the next place to look.
>
> **Source:** https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm

</details>
