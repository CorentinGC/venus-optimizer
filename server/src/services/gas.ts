import { ethers } from 'ethers';

/** Estime des frais gas agrégés (redeem+swap+mint) en BNB. */
export async function estimateGasFeesInBaseAsset(): Promise<number> {
  const rpcUrl = process.env.SERVER_BSC_RPC_URL;
  if (!rpcUrl) return 0;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');
  const gasLimit = BigInt(350000);
  const feeWei = gasPrice * gasLimit;
  const feeBNB = Number(ethers.formatEther(feeWei));
  return feeBNB;
}


