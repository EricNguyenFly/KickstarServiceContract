import { expect } from "chai";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { upgrades, ethers } from "hardhat";
import { ZERO_ADDRESS as AddressZero, MAX_UINT256 as MaxUint256, BN, ZERO_ADDRESS, getTimestamp, skipTime, setTime } from "./utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    TokenTest__factory,
    TokenTest,
    KickstarService__factory,
    KickstarService,
    Referral__factory,
    Referral
} from "../typechain-types";
import { BigNumber } from "ethers";

// signer variables
let owner: SignerWithAddress;
let admin: SignerWithAddress;
let client: SignerWithAddress;
let freelancer: SignerWithAddress;
let accounts: SignerWithAddress[];

// contract instance
let kickstarService: KickstarService;
let tokenTest: TokenTest;
let referral: Referral;

// constants
let DENOMINATOR: BN;
const ETH_100 = parseUnits("100", 18);
const ETH_1000 = parseUnits("1000", 18);
const ONE_DAY = 86400;
const PayType = {
    ALL: 0,
    MILESTONE: 1
}
const ProjectStatus = {
    PROCESSING: 0,
    FINISHED: 1,
    STOPPED: 2
}
const MilestoneStatus = {
    CREATED: 0,
    PAID: 1,
    ACCEPTED: 2,
    CLAIMED: 3,
    CANCELED: 4
}

describe("KickstarService", () => {
    beforeEach(async () => {
        [owner, admin, client, freelancer, ...accounts] = await ethers.getSigners();

        const TokenTest: TokenTest__factory = await ethers.getContractFactory("TokenTest");
        tokenTest = (await TokenTest.deploy()) as TokenTest;

        const Referral: Referral__factory = await ethers.getContractFactory("Referral");
        referral = (await Referral.deploy(owner.address)) as Referral;
        await referral.deployed();

        const KickstarService: KickstarService__factory = await ethers.getContractFactory("KickstarService");
        kickstarService = (await upgrades.deployProxy(KickstarService, [owner.address, referral.address])) as KickstarService;
        await kickstarService.deployed();

        await tokenTest.mint(client.address, ETH_1000);
        await tokenTest.connect(client).approve(kickstarService.address, MaxUint256);

        DENOMINATOR = await kickstarService.FEE_DENOMINATOR();
        await kickstarService.toggle();
    });

    describe("Deployment", () => {
        it("should revert with contract is already initialized", async () => {
            await expect(kickstarService.initialize(owner.address, referral.address)).to.be.revertedWith("Initializable: contract is already initialized");
        });

        it("Check parameters", async () => {
            expect(await kickstarService.owner()).to.equal(owner.address);
            expect(await kickstarService.referral()).to.equal(referral.address);
            expect(await kickstarService.referral()).to.equal(referral.address);
        });
    });

    describe("setPermittedToken", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setPermittedToken(tokenTest.address, true)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with pause", async () => {
            await kickstarService.toggle();
            expect(await kickstarService.paused()).to.be.true;
            await expect(kickstarService.setPermittedToken(tokenTest.address, true)).to.be.revertedWith("Pausable: paused");
        });

        it("should setPermittedToken successfully", async () => {
            await expect(kickstarService.setPermittedToken(tokenTest.address, true))
                .to.emit(kickstarService, "SetPermittedToken")
                .withArgs(tokenTest.address, true);
        });
    });

    describe("setServiceFeePercent", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(client).setServiceFeePercent(100, 100)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid service fee percent", async () => {
            await expect(kickstarService.setServiceFeePercent(0, 100)).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(100, 0)).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(100, DENOMINATOR.add(1))).to.be.revertedWith("Invalid service fee percent");
            await expect(kickstarService.setServiceFeePercent(DENOMINATOR.add(1), 100)).to.be.revertedWith("Invalid service fee percent");
        });

        it("should setServiceFeePercent successfully", async () => {
            const clientFeePercent = await kickstarService.clientFeePercent();
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            await expect(kickstarService.setServiceFeePercent(100, 100))
                .to.emit(kickstarService, "SetServiceFeePercent")
                .withArgs(clientFeePercent, freelancerFeePercent, 100, 100);
        });
    });

    describe("setMaxMilestone", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setMaxMilestone(5)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid maxMilestone", async () => {
            await expect(kickstarService.setMaxMilestone(0)).to.be.revertedWith("Invalid maxMilestone");
        });

        it("should setMaxMilestone successfully", async () => {
            const maxMilestone = await kickstarService.maxMilestone();
            await expect(kickstarService.setMaxMilestone(5))
                .to.emit(kickstarService, "SetMaxMilestone")
                .withArgs(maxMilestone, 5);

            expect(await kickstarService.maxMilestone()).to.equal(5);
        });
    });

    describe("setReferralContract", () => {
        it("should revert with caller is not owner", async () => {
            await expect(kickstarService.connect(admin).setReferralContract(referral.address)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Invalid address", async () => {
            await expect(kickstarService.setReferralContract(AddressZero)).to.be.revertedWith("Invalid address");
        });

        it("should revert with already exists", async () => {
            await expect(kickstarService.setReferralContract(referral.address)).to.be.revertedWith("Already exist");
        });

        it("should setReferralContract successfully", async () => {
            const referral = await kickstarService.referral();
            await expect(kickstarService.setReferralContract(tokenTest.address))
                .to.emit(kickstarService, "SetReferralContract")
                .withArgs(referral, tokenTest.address);
        });
    });

    describe("acceptBid", () => {
        const BUDGET = parseUnits("400", 18);
        let currentTime: any;

        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);
        })

        it("should revert with invalid address", async () => {
            await expect(kickstarService.connect(client).acceptBid(AddressZero, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid address");
        });

        it("should revert with Freelancer can not be same", async () => {
            await expect(kickstarService.connect(client).acceptBid(client.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Freelancer can not be same");
        });

        it("should revert with Invalid payment token", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, referral.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid payment token");
        });

        it("should revert with Budget must be greater than 0", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, 0, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Budget must be greater than 0");
        });

        it("should revert with Invalid length", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [], PayType.ALL)).to.be.revertedWith("Invalid length");
            await kickstarService.setMaxMilestone(1);
            await kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET], PayType.ALL);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET, BUDGET], PayType.ALL)).to.be.revertedWith("Invalid length");
        });

        it("should revert with Invalid expired date", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, 0, [BUDGET], PayType.ALL)).to.be.revertedWith("Invalid expired date");
        });

        it("should revert with Invalid amount of milestone", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [0], PayType.ALL)).to.be.revertedWith("Invalid amount of milestone");
        });

        it("should revert with Invalid total amount", async () => {
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, BUDGET, currentTime + ONE_DAY, [BUDGET.sub(1)], PayType.ALL)).to.be.revertedWith("Invalid total amount");
        });

        it("it should successfully with pay all", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL))
                .changeTokenBalances(tokenTest, [client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.getProjectById(lastId);
            expect(project.freelancer).to.equal(freelancer.address);
            expect(project.client).to.equal(client.address);
            expect(project.paymentToken).to.equal(tokenTest.address);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budget);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.ALL);

            let milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);

            milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone.add(budgetMilestones.length - 1));
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[budgetMilestones.length - 1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay milestone", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, tokenTest.address, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE))
                .changeTokenBalances(tokenTest, [client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.getProjectById(lastId);
            expect(project.freelancer).to.equal(freelancer.address);
            expect(project.client).to.equal(client.address);
            expect(project.paymentToken).to.equal(tokenTest.address);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budgetMilestones[0]);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts[0]);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.MILESTONE);

            const milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay all and pay by native", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.getProjectById(lastId);
            expect(project.freelancer).to.equal(freelancer.address);
            expect(project.client).to.equal(client.address);
            expect(project.paymentToken).to.equal(AddressZero);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budget);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.ALL);

            let milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);

            milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone.add(budgetMilestones.length - 1));
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[budgetMilestones.length - 1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });

        it("it should successfully with pay milestone and pay by native", async () => {
            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE, { value: amountDeposit }))
                .changeEtherBalances([client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            const lastId = await kickstarService.lastProjectId();
            const project = await kickstarService.getProjectById(lastId);
            expect(project.freelancer).to.equal(freelancer.address);
            expect(project.client).to.equal(client.address);
            expect(project.paymentToken).to.equal(AddressZero);
            expect(project.status).to.equal(ProjectStatus.PROCESSING);
            expect(project.budget).to.equal(budget);
            expect(project.amountPaid).to.equal(budgetMilestones[0]);
            expect(project.amountClaimAccepted).to.equal(0);
            expect(project.amountClientFee).to.equal(clientFeeAmounts[0]);
            expect(project.currentMilestone).to.equal(1);
            expect(project.expiredDate).to.equal(currentTime + ONE_DAY);
            expect(project.lastClaimId).to.equal(0);
            expect(project.clientFeePercent).to.equal(clientFeePercent);
            expect(project.freelancerFeePercent).to.equal(freelancerFeePercent);
            expect(project.payType).to.equal(PayType.MILESTONE);

            const milestone = await kickstarService.getMilestoneById(lastId, project.currentMilestone);
            expect(milestone.projectId).to.equal(lastId);
            expect(milestone.amount).to.equal(budgetMilestones[0]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
        });
    });

    describe("clientConfirmMilestone", () => {
        let currentTime: any;
        let lastProjectId: any;
        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            lastProjectId = await kickstarService.lastProjectId();
        })

        it("should revert with Invalid project id", async () => {
            await expect(kickstarService.clientConfirmMilestone(0, true)).to.be.revertedWith("Invalid project id");
            await expect(kickstarService.clientConfirmMilestone(lastProjectId + 1, true)).to.be.revertedWith("Invalid project id");
        });

        it("should revert with Project is expired", async () => {
            const expiredDate = (await kickstarService.getProjectById(lastProjectId)).expiredDate;
            await setTime(Number(expiredDate.add(1)));
            await expect(kickstarService.clientConfirmMilestone(lastProjectId, true)).to.be.revertedWith("Project is expired");
        });

        it("should revert with Caller is not the client of this project", async () => {
            await expect(kickstarService.clientConfirmMilestone(lastProjectId, true)).to.be.revertedWith("Caller is not the client of this project");
        });

        it("should revert with Project isn't processing", async () => {
            await kickstarService.judge(lastProjectId, true);
            await expect(kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true)).to.be.revertedWith("Project isn't processing");
        });

        it("should revert with This milestone has not been paid by client", async () => {
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, false);
            await expect(kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true)).to.be.revertedWith("This milestone has not been paid by client");
        });

        it("it should clientConfirmMilestone successfully with isDepositNextMilestone = false", async () => {
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, false);
            let currentProject = await kickstarService.getProjectById(lastProjectId);
            let milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(currentProject.amountClaimAccepted).to.equal(milestone.amount);
            expect(milestone.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE, { value: amountDeposit }))
                .changeEtherBalances([client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            lastProjectId = await kickstarService.lastProjectId();
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, false);
            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(currentProject.amountClaimAccepted).to.equal(milestone.amount);
            expect(milestone.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);
        });

        it("it should clientConfirmMilestone successfully with isDepositNextMilestone = true", async () => {
            let currentProject = await kickstarService.getProjectById(lastProjectId);
            let currentMilestoneId = currentProject.currentMilestone;
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true);
            currentProject = await kickstarService.getProjectById(lastProjectId);
            let milestoneBefore = await kickstarService.getMilestoneById(lastProjectId, currentMilestoneId);
            let milestoneAfter = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);

            expect(milestoneBefore.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(milestoneAfter.status).to.equal(MilestoneStatus.PAID);

            expect(currentProject.amountClaimAccepted).to.equal(milestoneBefore.amount);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("30", 18), parseUnits("20", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            let amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE, { value: amountDeposit }))
                .changeEtherBalances([client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            lastProjectId = await kickstarService.lastProjectId();
            currentProject = await kickstarService.getProjectById(lastProjectId);
            currentMilestoneId = currentProject.currentMilestone;
            amountDeposit = (budgetMilestones[1]).add(clientFeeAmounts[1]);
            await expect(kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true, { value: amountDeposit }))
                .changeEtherBalances([client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);
            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestoneBefore = await kickstarService.getMilestoneById(lastProjectId, currentMilestoneId);
            milestoneAfter = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);

            expect(milestoneBefore.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(milestoneAfter.status).to.equal(MilestoneStatus.PAID);
            expect(milestoneAfter.amount).to.equal(budgetMilestones[1]);

            expect(currentProject.amountClaimAccepted).to.equal(milestoneBefore.amount);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);
        });
    });

    describe("depositToContinueProject", () => {
        let currentTime: any;
        let lastProjectId: any;
        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("50", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            lastProjectId = await kickstarService.lastProjectId();
        })

        it("should revert with Invalid project id", async () => {
            await expect(kickstarService.depositToContinueProject(0)).to.be.revertedWith("Invalid project id");
            await expect(kickstarService.depositToContinueProject(lastProjectId + 1)).to.be.revertedWith("Invalid project id");
        });

        it("should revert with Project is expired", async () => {
            const expiredDate = (await kickstarService.getProjectById(lastProjectId)).expiredDate;
            await setTime(Number(expiredDate.add(1)));
            await expect(kickstarService.depositToContinueProject(lastProjectId)).to.be.revertedWith("Project is expired");
        });

        it("should revert with Caller is not the client of this project", async () => {
            await expect(kickstarService.depositToContinueProject(lastProjectId)).to.be.revertedWith("Caller is not the client of this project");
        });

        it("should revert with Project isn't processing", async () => {
            await kickstarService.judge(lastProjectId, true);
            await expect(kickstarService.connect(client).depositToContinueProject(lastProjectId)).to.be.revertedWith("Project isn't processing");
        });

        it("should revert with No milestone to deposit", async () => {
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true);
            await expect(kickstarService.connect(client).depositToContinueProject(lastProjectId)).to.be.revertedWith("No milestone to deposit");
        });

        it("should revert with Invalid milestone", async () => {
            await expect(kickstarService.connect(client).depositToContinueProject(lastProjectId)).to.be.revertedWith("Invalid milestone");
        });

        it("it should clientConfirmMilestone successfully with isDepositNextMilestone = false", async () => {
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, false);
            let currentProject = await kickstarService.getProjectById(lastProjectId);
            let milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(currentProject.amountClaimAccepted).to.equal(milestone.amount);
            expect(milestone.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            await kickstarService.connect(client).depositToContinueProject(lastProjectId);
            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestone.amount).to.equal(currentProject.milestoneBudgets[1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("50", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budgetMilestones.map((i) => {
                return i.mul(clientFeePercent).div(DENOMINATOR);
            });
            const amountDeposit = (budgetMilestones[0]).add(clientFeeAmounts[0]);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.MILESTONE, { value: amountDeposit }))
                .changeEtherBalances([client, kickstarService], [amountDeposit.mul(-1), amountDeposit]);

            lastProjectId = await kickstarService.lastProjectId();
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, false);
            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(currentProject.amountClaimAccepted).to.equal(milestone.amount);
            expect(milestone.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            await kickstarService.connect(client).depositToContinueProject(lastProjectId, { value: amountDeposit });
            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestone = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestone.amount).to.equal(currentProject.milestoneBudgets[1]);
            expect(milestone.status).to.equal(MilestoneStatus.PAID);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            await expect(kickstarService.connect(client).depositToContinueProject(lastProjectId, { value: amountDeposit })).to.be.revertedWith("No milestone to deposit");
        });
    });

    describe("claim", () => {
        let currentTime: any;
        let lastProjectId: any;
        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("50", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            lastProjectId = await kickstarService.lastProjectId();
        })

        it("should revert with Invalid project id", async () => {
            await expect(kickstarService.claim(0)).to.be.revertedWith("Invalid project id");
            await expect(kickstarService.claim(lastProjectId + 1)).to.be.revertedWith("Invalid project id");
        });

        it("should revert with Caller is not the Freelancer of this project", async () => {
            await expect(kickstarService.claim(lastProjectId)).to.be.revertedWith("Caller is not the freelancer of this project");
        });

        it("should revert with Nothing to claim", async () => {
            await expect(kickstarService.connect(freelancer).claim(lastProjectId)).to.be.revertedWith("Nothing to claim");
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true);
            await kickstarService.connect(freelancer).claim(lastProjectId);
            await expect(kickstarService.connect(freelancer).claim(lastProjectId)).to.be.revertedWith("Nothing to claim");
        });

        it("it should claim successfully", async () => {
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            let currentProject = await kickstarService.getProjectById(lastProjectId);
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true);
            let milestoneBefore = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);

            const freelancerFee = milestoneBefore.amount.mul(freelancerFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(freelancer).claim(lastProjectId))
                .changeEtherBalances([kickstarService, freelancer, owner], [milestoneBefore.amount.mul(-1), milestoneBefore.amount.sub(freelancerFee), freelancerFee]);

            let milestoneAfter = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestoneAfter.status).to.equal(MilestoneStatus.CLAIMED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            currentProject = await kickstarService.getProjectById(lastProjectId);
            milestoneBefore = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            await kickstarService.connect(client).clientConfirmMilestone(lastProjectId, true)
            await expect(kickstarService.connect(freelancer).claim(lastProjectId))
                .changeEtherBalances([kickstarService, freelancer, owner],
                    [milestoneBefore.amount.add(currentProject.amountClientFee).mul(-1),
                    milestoneBefore.amount.sub(freelancerFee),
                    freelancerFee.add(currentProject.amountClientFee)]);
            milestoneAfter = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestoneAfter.status).to.equal(MilestoneStatus.CLAIMED);

            currentProject = await kickstarService.getProjectById(lastProjectId);
            expect(currentProject.status).to.equal(ProjectStatus.FINISHED);
        });
    });

    describe("judge", () => {
        let currentTime: any;
        let lastProjectId: any;
        beforeEach(async () => {
            currentTime = await getTimestamp();
            await kickstarService.setPermittedToken(tokenTest.address, true);

            const budget = parseUnits("100", 18);
            const budgetMilestones = [parseUnits("50", 18), parseUnits("50", 18)];
            const clientFeePercent = await kickstarService.clientFeePercent();
            const clientFeeAmounts = budget.mul(clientFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(client).acceptBid(freelancer.address, AddressZero, budget, currentTime + ONE_DAY, budgetMilestones, PayType.ALL, { value: budget.add(clientFeeAmounts) }))
                .changeEtherBalances([client, kickstarService], [budget.add(clientFeeAmounts).mul(-1), budget.add(clientFeeAmounts)]);

            lastProjectId = await kickstarService.lastProjectId();
        })

        it("should revert with Invalid project id", async () => {
            await expect(kickstarService.judge(0, true)).to.be.revertedWith("Invalid project id");
            await expect(kickstarService.judge(lastProjectId + 1, true)).to.be.revertedWith("Invalid project id");
        });

        it("should revert with Ownable: caller is not the owner", async () => {
            await expect(kickstarService.connect(freelancer).judge(lastProjectId, true)).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("should revert with Project hasn't been processing yet", async () => {
            await kickstarService.judge(lastProjectId, true);
            await expect(kickstarService.judge(lastProjectId, true)).to.be.revertedWith("Project hasn't been processing yet");
        });

        it("it should judge successfully with isStop = false", async () => {
            const freelancerFeePercent = await kickstarService.freelancerFeePercent();
            let currentProject = await kickstarService.getProjectById(lastProjectId);
            await kickstarService.judge(lastProjectId, false);
            let milestoneBefore = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestoneBefore.status).to.equal(MilestoneStatus.ACCEPTED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);

            const freelancerFee = milestoneBefore.amount.mul(freelancerFeePercent).div(DENOMINATOR);
            await expect(kickstarService.connect(freelancer).claim(lastProjectId))
                .changeEtherBalances([kickstarService, freelancer, owner], [milestoneBefore.amount.mul(-1), milestoneBefore.amount.sub(freelancerFee), freelancerFee]);

            let milestoneAfter = await kickstarService.getMilestoneById(lastProjectId, currentProject.currentMilestone);
            expect(milestoneAfter.status).to.equal(MilestoneStatus.CLAIMED);
            expect(currentProject.status).to.equal(ProjectStatus.PROCESSING);
        });

        it("it should judge successfully with isStop = true", async () => {
            const currentProject = await kickstarService.getProjectById(lastProjectId);
            const amountRefund = currentProject.amountPaid.sub(currentProject.amountClaimAccepted).add(currentProject.amountClientFee);
            await expect(kickstarService.judge(lastProjectId, true))
                .changeEtherBalances([kickstarService, client], [amountRefund.mul(-1), amountRefund]);

            const projectAfter = await kickstarService.getProjectById(lastProjectId);
            const milestone = await kickstarService.getMilestoneById(lastProjectId, projectAfter.currentMilestone);
            expect(milestone.status).to.equal(MilestoneStatus.CANCELED);
            expect(projectAfter.status).to.equal(ProjectStatus.STOPPED);

            await expect(kickstarService.connect(freelancer).claim(lastProjectId)).to.revertedWith("Nothing to claim");
        });
    });
});
