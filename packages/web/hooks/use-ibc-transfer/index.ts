import { useEffect, useMemo } from "react";
import {
  AccountSetBase,
  CosmosAccount,
  CosmwasmAccount,
  getKeplrFromWindow,
  WalletStatus,
} from "@keplr-wallet/stores";
import {
  basicIbcTransfer,
  OsmosisAccount,
  IBCTransferHistory,
  UncommitedHistory,
  FakeFeeConfig,
} from "@osmosis-labs/stores";
import { AmountConfig } from "@keplr-wallet/hooks";
import { useStore } from "../../stores";
import { useCustomBech32Address } from "./use-custom-bech32address";
import { IbcTransfer, CustomCounterpartyConfig } from ".";

/**
 * Convenience hook for handling IBC transfer state. Supports user setting custom & validated bech32 counterparty address when withdrawing.
 *
 * @param currency IBC counterparty currency.
 * @param counterpartyChainId ChainId of counterparty.
 * @param sourceChannelId IBC route source channel id.
 * @param destChannelId IBC route destination channel id.
 * @param isWithdraw Specifies whether transfer is a withdrawal.
 * @param ics20ContractAddress Smart contract address should counterparty currency be a CW20 token.
 * @returns [osmosis account, counterparty account, observable amount config, isLoading, IBC transfer callback, custom withdrawal address manager if withdrawing]
 */
export function useIbcTransfer({
  currency,
  counterpartyChainId,
  sourceChannelId,
  destChannelId,
  isWithdraw,
  ics20ContractAddress,
}: IbcTransfer): [
  AccountSetBase & CosmosAccount & CosmwasmAccount & OsmosisAccount,
  AccountSetBase & CosmosAccount & CosmwasmAccount & OsmosisAccount,
  AmountConfig,
  boolean,
  (
    /** Handle IBC transfer events containing `send_packet` event type. */
    onFulfill?: (
      event: Omit<IBCTransferHistory, "status" | "createdAt">
    ) => void,
    /** Handle when the IBC trasfer successfully broadcast to relayers. */
    onBroadcasted?: (event: Omit<UncommitedHistory, "createdAt">) => void
  ) => void,
  CustomCounterpartyConfig | undefined
] {
  const { chainStore, accountStore, queriesStore } = useStore();
  const { chainId } = chainStore.osmosis;

  const account = accountStore.getAccount(chainId);
  const counterpartyAccount = accountStore.getAccount(counterpartyChainId);

  const feeConfig = useMemo(
    () =>
      new FakeFeeConfig(
        chainStore,
        isWithdraw ? chainId : counterpartyChainId,
        isWithdraw
          ? account.cosmos.msgOpts.ibcTransfer.gas
          : counterpartyAccount.cosmos.msgOpts.ibcTransfer.gas
      ),
    // eslint-disable-next-line
    [chainId, chainStore, account, counterpartyAccount]
  );
  const amountConfig = useMemo(() => {
    const config = new AmountConfig(
      chainStore,
      queriesStore,
      isWithdraw ? chainId : counterpartyChainId,
      isWithdraw ? account.bech32Address : counterpartyAccount.bech32Address,
      feeConfig
    );
    config.setSendCurrency(isWithdraw ? currency : currency.originCurrency!);
    return config;
    // eslint-disable-next-line
  }, [
    chainStore,
    queriesStore,
    account.bech32Address,
    counterpartyAccount.bech32Address,
    feeConfig,
  ]);
  const [customBech32Address, isCustomAddressValid, setCustomBech32Address] =
    useCustomBech32Address();
  const customCounterpartyConfig: CustomCounterpartyConfig | undefined =
    isWithdraw
      ? {
          bech32Address: customBech32Address,
          isValid: isCustomAddressValid,
          setBech32Address: (bech32Address: string) =>
            setCustomBech32Address(
              bech32Address,
              chainStore.getChain(counterpartyChainId).bech32Config
                .bech32PrefixAccAddr
            ),
        }
      : undefined;

  // open keplr dialog to request connecting to counterparty chain
  useEffect(() => {
    if (
      account.bech32Address &&
      (counterpartyAccount.walletStatus === WalletStatus.NotInit ||
        counterpartyAccount.walletStatus === WalletStatus.Rejected)
    ) {
      counterpartyAccount.init();
    }
  }, [account.bech32Address, counterpartyAccount]);

  useEffect(() => {
    if (
      account.walletStatus === WalletStatus.Loaded && // TODO: handle mobile web (it is always connected)
      currency.originCurrency
    ) {
      if ("contractAddress" in currency.originCurrency) {
        getKeplrFromWindow()
          .then((keplr) => {
            // If the keplr is from extension and the ibc token is from cw20,
            // suggest the token to the keplr.
            if (
              keplr &&
              keplr.mode === "extension" &&
              currency.originChainId &&
              currency.originCurrency &&
              "contractAddress" in currency.originCurrency
            ) {
              keplr
                .suggestToken(
                  currency.originChainId,
                  (currency.originCurrency as any).contractAddress
                )
                .catch((e) => {
                  console.error(e);
                });
            }
          })
          .catch((e: unknown) => {
            console.error(e);
          });
      }
    }
  }, [account.walletStatus, currency.originCurrency, currency.originChainId]);

  const transfer: (
    onFulfill?: (
      event: Omit<IBCTransferHistory, "status" | "createdAt">
    ) => void,
    onBroadcasted?: (event: Omit<UncommitedHistory, "createdAt">) => void
  ) => void = async (onFulfill, onBroadcasted) => {
    try {
      if (isWithdraw) {
        await basicIbcTransfer(
          {
            account,
            chainId,
            channelId: sourceChannelId,
          },
          {
            account: counterpartyAccount,
            chainId: counterpartyChainId,
            channelId: destChannelId,
            bech32AddressOverride:
              customBech32Address !== "" ? customBech32Address : undefined,
          },
          currency,
          amountConfig,
          onBroadcasted,
          onFulfill
        );
      } else {
        await basicIbcTransfer(
          {
            account: counterpartyAccount,
            chainId: counterpartyChainId,
            channelId: destChannelId,
            contractTransfer:
              ics20ContractAddress &&
              currency.originCurrency &&
              "contractAddress" in currency.originCurrency
                ? {
                    contractAddress: currency.originCurrency["contractAddress"],
                    cosmwasmAccount: counterpartyAccount,
                    ics20ContractAddress: ics20ContractAddress,
                  }
                : undefined,
          },
          {
            account,
            chainId,
            channelId: sourceChannelId,
          },
          currency,
          amountConfig,
          onBroadcasted,
          onFulfill
        );
      }
    } catch (e) {
      console.error(e);
    }
  };

  return [
    account,
    counterpartyAccount,
    amountConfig,
    (isWithdraw && account.txTypeInProgress === "ibcTransfer") ||
      (!isWithdraw && counterpartyAccount.txTypeInProgress === "ibcTransfer"),
    transfer,
    customCounterpartyConfig,
  ];
}

export * from "./types";
