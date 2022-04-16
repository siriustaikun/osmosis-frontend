import { KVStore } from "@keplr-wallet/common";
import {
  ChainGetter,
  CoinGeckoPriceStore,
  ObservableChainQuery,
  QueryResponse,
} from "@keplr-wallet/stores";
import { Dec } from "@keplr-wallet/unit";
import { PricePretty } from "@keplr-wallet/unit/build/price-pretty";
import { autorun, makeObservable } from "mobx";
import { computedFn } from "mobx-utils";
import { ObservableQueryNumPools } from "./num-pools";
import { ObservablePool } from "./pool";
import { Pools } from "./types";

export class ObservableQueryPools extends ObservableChainQuery<Pools> {
  constructor(
    kvStore: KVStore,
    chainId: string,
    chainGetter: ChainGetter,
    queryNumPools: ObservableQueryNumPools
  ) {
    super(
      kvStore,
      chainId,
      chainGetter,
      "/osmosis/gamm/v1beta1/pools?pagination.limit=1000"
    );
    let limit = 1000;

    makeObservable(this);

    autorun(() => {
      const numPools = queryNumPools.numPools;
      if (numPools > limit) {
        limit = numPools;
        this.setUrl(`/osmosis/gamm/v1beta1/pools?pagination.limit=${limit}`);
      }
    });
  }

  protected setResponse(response: Readonly<QueryResponse<Pools>>) {
    super.setResponse(response);

    const chainInfo = this.chainGetter.getChain(this.chainId);
    const denomsInPools: string[] = [];
    // Register the denoms in the response.
    for (const pool of response.data.pools) {
      for (const asset of pool.poolAssets) {
        denomsInPools.push(asset.token.denom);
      }
    }

    chainInfo.addUnknownCurrencies(...denomsInPools);
  }

  /** Returns `undefined` if the pool does not exist or the data has not loaded. */
  readonly getPool: (id: string) => ObservablePool | undefined = computedFn(
    (id: string) => {
      if (!this.response) {
        return undefined;
      }

      const raw = this.response.data.pools.find((raw) => raw.id === id);
      if (!raw) {
        return undefined;
      }

      return new ObservablePool(this.chainId, this.chainGetter, raw);
    }
  );

  /** Returns `undefined` if pool data has not loaded, and `true`/`false` for if the pool exists. */
  readonly poolExists: (id: string) => boolean | undefined = computedFn(
    (id: string) => {
      // TODO: address pagination limit
      if (!this.response || this.isFetching || !this.isStarted) {
        return undefined;
      }

      return this.response.data.pools.some((raw) => raw.id === id);
    }
  );

  readonly computeAllTotalValueLocked = computedFn(
    (priceStore: CoinGeckoPriceStore): PricePretty => {
      const fiatCurrency = priceStore.getFiatCurrency(
        priceStore.defaultVsCurrency
      )!;
      let price = new PricePretty(fiatCurrency, new Dec(0));
      if (!this.response) {
        return price;
      }

      this.response.data.pools.forEach((raw) => {
        const pool = this.getPool(raw.id);

        if (pool) {
          price = price.add(pool.computeTotalValueLocked(priceStore));
        }
      });

      return price;
    }
  );

  readonly getAllPools = computedFn((): ObservablePool[] => {
    if (!this.response) {
      return [];
    }

    return this.response.data.pools.map((raw) => {
      return this.getPool(raw.id)!;
    });
  });

  readonly getPools = computedFn(
    (itemsPerPage: number, page: number): ObservablePool[] => {
      if (!this.response) {
        return [];
      }

      const offset = (page - 1) * itemsPerPage;
      return this.response.data.pools
        .slice(offset, offset + itemsPerPage)
        .map((raw) => {
          return this.getPool(raw.id)!;
        });
    }
  );

  readonly getPoolsDescendingOrderTVL = computedFn(
    (
      priceStore: CoinGeckoPriceStore,
      itemsPerPage: number,
      page: number
    ): ObservablePool[] => {
      if (!this.response) {
        return [];
      }

      let pools = this.getAllPools();

      pools = pools
        .slice()
        .sort((poolA: ObservablePool, poolB: ObservablePool) => {
          const poolATvl = poolA.computeTotalValueLocked(priceStore).toDec();
          const poolBTvl = poolB.computeTotalValueLocked(priceStore).toDec();
          return poolATvl.gt(poolBTvl) ? -1 : 1;
        });

      const offset = (page - 1) * itemsPerPage;
      return pools.slice(offset, offset + itemsPerPage);
    }
  );
}
