import hre, { ethers, artifacts } from 'hardhat';
import { expect } from 'chai';
import {
  DeployUpgradeFunc,
  NamedAddresses,
  SetupUpgradeFunc,
  TeardownUpgradeFunc,
  ValidateUpgradeFunc
} from '@custom-types/types';
import { getImpersonatedSigner } from '@test/helpers';

const ZERO_ADDRESS = ethers.constants.AddressZero;

// How this will work:
// 1. DAO deploys a factory contract
// 2. DAO uses factory contract to deploy a Tribal Council
// 3. DAO adds members to the Tribal Council
// 4. Tribal Council deploys a factory contract
// 5. Factory contract used to deploy several product specific pods
// 6. Relevant authority gives each pod the necessary role
// Think through what happens if the controller is updated or changed somehow

const fipNumber = '82'; // Change me!

// Do any deployments
// This should exclusively include new contract deployments
const deploy: DeployUpgradeFunc = async (deployAddress: string, addresses: NamedAddresses, logging: boolean) => {
  // 1. Deploy public pod executor
  const podExecutorFactory = await ethers.getContractFactory('PodExecutor');
  const podExecutor = await podExecutorFactory.deploy();
  await podExecutor.deployTransaction.wait();
  console.log('PodExecutor deployed to', podExecutor.address);

  // 2. Deploy tribalCouncilPodFactory
  const podFactoryEthersFactory = await ethers.getContractFactory('PodFactory');
  const tribalCouncilPodFactory = await podFactoryEthersFactory.deploy(
    addresses.core, // core
    addresses.feiDAOTimelock, // podAdmin - adds members etc. FEI DAO timelock
    addresses.podController, // podController
    addresses.memberToken, // podMembershipToken
    podExecutor.address // Public pod executor
  );
  await tribalCouncilPodFactory.deployTransaction.wait();

  console.log('DAO pod factory deployed to:', tribalCouncilPodFactory.address);

  // 3. Deploy tribalCouncilPodFactory
  const protocolTierPodFactory = await podFactoryEthersFactory.deploy(
    addresses.core, // core
    ZERO_ADDRESS, // Set podAdmin to be zero address. Will later be set to Tribal council pod timelock
    addresses.podController, // podController
    addresses.memberToken, // podMembershipToken
    podExecutor.address // Public pod executor
  );
  await protocolTierPodFactory.deployTransaction.wait();
  console.log('Protocol tier pod factory deployed to:', protocolTierPodFactory.address);

  return {
    podExecutor,
    tribalCouncilPodFactory,
    protocolTierPodFactory
  };
};

// Do any setup necessary for running the test.
// This could include setting up Hardhat to impersonate accounts,
// ensuring contracts have a specific state, etc.
const setup: SetupUpgradeFunc = async (addresses, oldContracts, contracts, logging) => {
  // TODO: Remove once have SHIP tokens on Mainnet
  const inviteTokenAddress = '0x872EdeaD0c56930777A82978d4D7deAE3A2d1539';
  const priviledgedAddress = '0x2149A222feD42fefc3A120B3DdA34482190fC666';

  const inviteTokenABI = [
    'function mint(address account, uint256 amount) external',
    'function balanceOf(address account) external view returns (uint256)'
  ];
  // Mint Orca Ship tokens to deploy address, to allow to deploy contracts
  const priviledgedAddressSigner = await getImpersonatedSigner(priviledgedAddress);
  const inviteToken = new ethers.Contract(inviteTokenAddress, inviteTokenABI, priviledgedAddressSigner);

  await inviteToken.mint(addresses.feiDAOTimelock, 10);
  await inviteToken.mint(contracts.tribalCouncilPodFactory.address, 10);
};

// Tears down any changes made in setup() that need to be
// cleaned up before doing any validation checks.
const teardown: TeardownUpgradeFunc = async (addresses, oldContracts, contracts, logging) => {
  console.log(`No actions to complete in teardown for fip${fipNumber}`);
};

// Run any validations required on the fip using mocha or console logging
// IE check balances, check state of contracts, etc.
const validate: ValidateUpgradeFunc = async (addresses, oldContracts, contracts, logging) => {
  // 1. Validate admin of tribeCouncilPodFactory is the DAO timelock
  const tribalCouncilPodFactory = contracts.tribalCouncilPodFactory;
  const tribeCouncilFactoryAdmin = await tribalCouncilPodFactory.podAdmin();
  expect(tribeCouncilFactoryAdmin).to.equal(addresses.feiDAOTimelock);

  // 2. Validate admin of protocolTierPodFactory is the TribalCouncil pod timelock
  // const protocolTierPodFactory = contracts.protocolTierPodFactory;
  // const protocolTierFactoryAdmin = await protocolTierPodFactory.podAdmin();
  // expect(protocolTierFactoryAdmin).to.equal(addresses.tribalCouncilTimelock);

  // 3. Validate that Tribal Council pod has been correctly deployed
  const tribalCouncilPodId = await tribalCouncilPodFactory.latestPodId(); // TODO: How to make this robust?
  const tribalCouncilTimelockAddress = await tribalCouncilPodFactory.getPodTimelock(tribalCouncilPodId);
  const tribalCouncilSafeAddress = await tribalCouncilPodFactory.getPodSafe(tribalCouncilPodId);
  const tribalCouncilTimelock = await ethers.getContractAt('OptimisticTimelock', tribalCouncilTimelockAddress);

  const gnosisSafeIsProposer = await tribalCouncilTimelock.hasRole(
    ethers.utils.id('PROPOSER_ROLE'),
    tribalCouncilSafeAddress
  );
  expect(gnosisSafeIsProposer).to.be.true;

  const publicExecutorIsExecutor = await tribalCouncilTimelock.hasRole(
    ethers.utils.id('EXECUTOR_ROLE'),
    addresses.podExecutor
  );
  expect(publicExecutorIsExecutor).to.be.true;

  const numCouncilMembers = await tribalCouncilPodFactory.getNumMembers(tribalCouncilPodId);
  expect(numCouncilMembers).to.equal(9);

  const councilThreshold = await tribalCouncilPodFactory.getPodThreshold(tribalCouncilPodId);
  // this is coming back as 22
  console.log({ councilThreshold });
  expect(councilThreshold).to.equal(5);

  // 5. Validate that tribal council has the correct roles, if any

  // 6. Validate that protocol specific pods have been correctly deployed
  // const fusePod = contracts.fusePod;
};

export { deploy, setup, teardown, validate };
