# Licence recommendation (DECISION NOT MADE)

This repository currently carries **no open-source licence**. `package.json` says
`UNLICENSED` and `private: true`. Until the owner decides, all rights are reserved and
nothing here is published.

## Recommendation: Apache-2.0

**Why Apache-2.0 rather than MIT.** Both are permissive and both would be adopted without
friction. Apache-2.0 adds two things that matter for a governance tool specifically:

1. **An express patent grant** (section 3). MIT is silent on patents. A tool that companies
   embed in a change-control path is one that corporate legal review will look at, and the
   patent grant removes the most common objection. Several large-company open-source policies
   prefer or require it for exactly this reason.
2. **A trademark reservation** (section 6). If the project name is ever worth protecting,
   Apache-2.0 already reserves it. MIT does not.

The cost is a longer file and a `NOTICE` convention. That is a small price for a project
intended to be adopted inside other organisations.

**Why not a copyleft licence (GPL/AGPL).** modelpromote is designed to be imported into
someone else's proprietary application. Copyleft would defeat the adoption model. AGPL would
be actively wrong here: there is no hosted service to protect.

**Why not source-available (BSL, Elastic).** Those protect against a cloud provider reselling
your hosted product. There is no hosted product, and source-available terms would cost the
adoption this project depends on for any value at all.

## What the owner needs to decide

1. **The licence itself.** Apache-2.0 is recommended. MIT is a reasonable alternative if
   maximum familiarity matters more than the patent grant.
2. **The copyright line.** Apache-2.0 needs a copyright holder: a personal name or a company
   name. This is an identity decision with the same considerations as the git author email,
   and it interacts with the employment and IP position governing this work. It should not
   be filled in by default.
3. **Whether a `NOTICE` file is wanted.** Optional under Apache-2.0, useful if attribution
   should survive redistribution.

## To apply the recommendation

Add the standard Apache-2.0 text as `LICENSE`, insert the chosen copyright line, set
`"license": "Apache-2.0"` in `package.json`, and update the README's licence section. None of
that has been done, deliberately.
