import { defineMatrix } from '../_utils/defineMatrix'
import { type RelationLoadStrategy, providersSupportingRelationJoins } from './_common'

export default defineMatrix(() => [
  providersSupportingRelationJoins.map((provider) => ({ provider })),
  [
    {
      strategy: 'query' as RelationLoadStrategy,
    },
    {
      strategy: 'join' as RelationLoadStrategy,
    },
  ],
])
