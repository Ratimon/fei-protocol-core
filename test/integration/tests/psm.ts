import chai, { expect } from 'chai';
import CBN from 'chai-bn';
import { solidity } from 'ethereum-waffle';
import hre, { ethers } from 'hardhat';
import { NamedAddresses, NamedContracts } from '@custom-types/types';
import {
  expectRevert,
  getAddresses,
  getImpersonatedSigner,
  increaseTime,
  latestTime,
  resetFork,
  time
} from '@test/helpers';
import proposals from '@test/integration/proposals_config';
import { TestEndtoEndCoordinator } from '@test/integration/setup';
import { forceEth } from '@test/integration/setup/utils';
import { Core, PegStabilityModule, PriceBoundPSM, PSMRouter, WETH9 } from '@custom-types/contracts';
import { Signer } from 'ethers';

const toBN = ethers.BigNumber.from;

before(async () => {
  chai.use(CBN(ethers.BigNumber));
  chai.use(solidity);
  await resetFork();
});

describe.only('e2e-peg-stability-module', function () {
  const impersonatedSigners: { [key: string]: Signer } = {};
  let contracts: NamedContracts;
  let contractAddresses: NamedAddresses;
  let deployAddress: string;
  let e2eCoord: TestEndtoEndCoordinator;
  let doLogging: boolean;
  let psmRouter;
  let userAddress;
  let minterAddress;
  let weth;
  let daiPSM;
  let wethPSM;
  let fei;
  let core;
  let beneficiaryAddress1;

  before(async function () {
    // Setup test environment and get contracts
    const version = 1;
    deployAddress = (await ethers.getSigners())[0].address;
    if (!deployAddress) throw new Error(`No deploy address!`);
    const addresses = await getAddresses();
    // add any addresses you want to impersonate here
    const impersonatedAddresses = [
      addresses.userAddress,
      addresses.pcvControllerAddress,
      addresses.governorAddress,
      addresses.minterAddress,
      addresses.burnerAddress,
      addresses.beneficiaryAddress1,
      addresses.beneficiaryAddress2
    ];
    ({ userAddress, minterAddress, beneficiaryAddress1 } = addresses);

    doLogging = Boolean(process.env.LOGGING);

    const config = {
      logging: doLogging,
      deployAddress: deployAddress,
      version: version
    };

    e2eCoord = new TestEndtoEndCoordinator(config, proposals);

    doLogging && console.log(`Loading environment...`);
    ({ contracts, contractAddresses } = await e2eCoord.loadEnvironment());
    ({ weth, daiPSM, wethPSM, psmRouter, fei, core } = contracts);
    doLogging && console.log(`Environment loaded.`);
    await core.grantMinter(minterAddress);

    for (const address of impersonatedAddresses) {
      impersonatedSigners[address] = await getImpersonatedSigner(address);
    }
  });

  describe('fallback', function () {
    it('sending eth to the fallback function fails', async () => {
      await expectRevert(
        impersonatedSigners[userAddress].sendTransaction({
          to: psmRouter.address,
          value: ethers.utils.parseEther('1.0')
        }),
        'PSMRouter: redeem not active'
      );
    });
  });

  describe('weth-router', async () => {
    describe('redeem', async () => {
      const redeemAmount = 10_000_000;
      beforeEach(async () => {
        await fei.connect(impersonatedSigners[minterAddress]).mint(userAddress, redeemAmount);
        await fei.connect(impersonatedSigners[userAddress]).approve(psmRouter.address, redeemAmount);
      });

      it('exchanges 10,000,000 FEI for 1994 ETH', async () => {
        const startingFEIBalance = await fei.balanceOf(userAddress);
        const startingETHBalance = await ethers.provider.getBalance(beneficiaryAddress1);
        const expectedEthAmount = await psmRouter.getRedeemAmountOut(redeemAmount);

        await psmRouter
          .connect(impersonatedSigners[userAddress])
          ['redeem(address,uint256,uint256)'](beneficiaryAddress1, redeemAmount, expectedEthAmount);

        const endingFEIBalance = await fei.balanceOf(userAddress);
        const endingETHBalance = await ethers.provider.getBalance(beneficiaryAddress1);

        expect(endingETHBalance.sub(startingETHBalance)).to.be.equal(expectedEthAmount);
        expect(startingFEIBalance.sub(endingFEIBalance)).to.be.equal(redeemAmount);
      });

      it('exchanges 5,000,000 FEI for 997 ETH', async () => {
        const startingFEIBalance = await fei.balanceOf(userAddress);
        const startingETHBalance = await ethers.provider.getBalance(beneficiaryAddress1);
        const expectedEthAmount = await psmRouter.getRedeemAmountOut(redeemAmount / 2);

        await psmRouter
          .connect(impersonatedSigners[userAddress])
          ['redeem(address,uint256,uint256)'](beneficiaryAddress1, redeemAmount / 2, expectedEthAmount);

        const endingFEIBalance = await fei.balanceOf(userAddress);
        const endingETHBalance = await ethers.provider.getBalance(beneficiaryAddress1);
        expect(endingETHBalance.sub(startingETHBalance)).to.be.equal(expectedEthAmount);
        expect(startingFEIBalance.sub(endingFEIBalance)).to.be.equal(redeemAmount / 2);
      });

      it('passthrough getRedeemAmountOut returns same value as PSM', async () => {
        const actualEthAmountRouter = await psmRouter.getRedeemAmountOut(redeemAmount);
        const actualEthAmountPSM = await wethPSM.getRedeemAmountOut(redeemAmount);
        expect(actualEthAmountPSM).to.be.equal(actualEthAmountRouter);
      });
    });

    describe('mint', function () {
      const mintAmount = 2_000;
      beforeEach(async () => {
        await forceEth(userAddress);
      });

      it('mint succeeds with 1 ether', async () => {
        const minAmountOut = await psmRouter.getMintAmountOut(ethers.constants.WeiPerEther);
        const userStartingFEIBalance = await fei.balanceOf(userAddress);

        await psmRouter
          .connect(impersonatedSigners[userAddress])
          ['mint(address,uint256)'](userAddress, minAmountOut, { value: ethers.constants.WeiPerEther });

        const userEndingFEIBalance = await fei.balanceOf(userAddress);
        expect(userEndingFEIBalance.sub(userStartingFEIBalance)).to.be.gte(minAmountOut);
      });

      it('mint succeeds with 2 ether', async () => {
        const ethAmountIn = toBN(2).mul(ethers.constants.WeiPerEther);
        const minAmountOut = await psmRouter.getMintAmountOut(ethAmountIn);
        const userStartingFEIBalance = await fei.balanceOf(userAddress);

        await psmRouter
          .connect(impersonatedSigners[userAddress])
          ['mint(address,uint256)'](userAddress, minAmountOut, { value: ethAmountIn });

        const userEndingFEIBalance = await fei.balanceOf(userAddress);
        expect(userEndingFEIBalance.sub(userStartingFEIBalance)).to.be.equal(minAmountOut);
      });

      it('passthrough getMintAmountOut returns same value as PSM', async () => {
        const actualEthAmountRouter = await psmRouter.getMintAmountOut(mintAmount);
        const actualEthAmountPSM = await wethPSM.getMintAmountOut(mintAmount);
        expect(actualEthAmountPSM).to.be.equal(actualEthAmountRouter);
      });
    });
  });

  describe('weth-psm', async () => {
    describe('redeem', function () {
      const redeemAmount = 10_000_000;
      beforeEach(async () => {
        await fei.connect(impersonatedSigners[minterAddress]).mint(userAddress, redeemAmount);
        await fei.connect(impersonatedSigners[userAddress]).approve(psmRouter.address, redeemAmount);
      });
    });

    describe('mint', function () {
      const mintAmount = 2_000;
      beforeEach(async () => {
        await forceEth(userAddress);
        /// deposit into weth
        /// approve weth to be spent by the wethPSM
      });
    });
  });

  describe('dai_psm', async () => {
    describe('redeem', function () {});
    describe('mint', function () {});
  });
});
