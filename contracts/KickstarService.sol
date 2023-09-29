// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./lib/Helper.sol";

contract KickstarService is PausableUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    //  prettier-ignore
    /*
     *  @dev Project struct
     */
    struct Project {
        address         freelancer;               // Freelancer of project
        address         client;                   // Client of project
        address         paymentToken;             // Project token using in Project
        ProjectStatus   status;                   // Project's status
        uint256         budget;                   // Amount of all milestone
        uint256         amountPaid;               // The amount paid
        uint256         amountClientFee;          // The tax amount
        uint256         currentMilestone;         // Current milestone
        uint256         createdDate;              // Project's created day
        uint256         expiredDate;              // Project's expired day
        uint256         lastClaimId;              // Id of this milestone last claim
        uint256[]       milestoneBudgets;         // List of budget of milestones
        uint256         clientFeePercent;         // Client fee percent
		uint256         freelancerFeePercent;     // Freelancer fee percent
        PayType         payType;                  // Type of pay
    }

    //  prettier-ignore
    /*
     *  @dev Milestone struct is information of milestone includes: created date, paid date, status
     */
    struct Milestone {
        uint256 projectId;                  // Id of project
		uint256 amount;                     // Milestone's active date
        MilestoneStatus status;             // Milestone status
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                           Value
     *           |                               |
     *  Pay all                                 ALL
     *  Pay in milestone                        MILESTONE
     */
    enum PayType {
        ALL,
        MILESTONE
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                                              Value
     *           |                                                  |
     *  After Client requests project                           REQUESTING
     *  After Client escrows money                              PAID
     *  When project is still in processing                     CLAIMING
     *  After the last milestone is completed                   FINISHED
     *  After Client stop project                               STOPPED
     */
    enum ProjectStatus {
        REQUESTING,
        PAID,
        PROCESSING,
        FINISHED,
        STOPPED
    }

    /**
     *  MilestoneStatus enum is status of per milestone
     *
     *          Suit                                                                        Value
     *           |                                                                             |
     *  Default milestone status                                                            CREATED
     *  After Freelancer confirm milestone to release                                       FREELANCER_CONFIRMED
     *  After Client confirm to release money                                               ACCEPTED
     *  After Freelancer claim milestone                                                    CLAIMED
     *  After Client not provide service on time and fund is refunded to Freelancer         CANCELED
     */
    enum MilestoneStatus {
        PENDING,
        PAID,
        FREELANCER_CONFIRMED,
        ACCEPTED,
        CLAIMED,
        CANCELED
    }

    uint256 public constant FEE_DENOMINATOR = 10000;

    /**
     *  @dev maxMilestone uint256 is max qty milestone of each project
     */
    uint256 public maxMilestone = 20;

    /**
     *  @dev serviceFee uint256 is service fee of each project
     */
    uint256 public clientFeePercent = 1500;
    uint256 public freelancerFeePercent = 500;

    /**
     *  @dev lastProjectId uint256 is the latest requested project ID started by 1
     */
    uint256 public lastProjectId;

    /**
     *  @dev Mapping project ID to a project detail
     */
    mapping(uint256 => Project) public projects;

    /**
     *  @dev Mapping project ID to milestone ID to get info of per milestone
     */
    mapping(uint256 => mapping(uint256 => Milestone)) public milestones;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => bool) public permittedPaymentTokens;

    event AcceptBid(
        uint256 indexed projectId,
        address freelancer,
        address client,
        address paymentToken,
        uint256 budget,
        uint256 createdDate,
        uint256 expiredDate,
        ProjectStatus milestoneStatus,
        PayType payType,
        uint256 totalMilestone,
        uint256[] milestoneBudgets
    );
    event Deposited(
        uint256 indexed projectId,
        uint256[] milestoneIds,
        uint256 totalAmount,
        ProjectStatus projectStatus
    );
    event FreelancerAcceptProject(uint256 indexed projectId);
    event ClientConfirmMilestone(uint256 indexed projectId, uint256 indexed milestoneId, bool isDepositNextMilestone);
    event ConfirmedToRelease(uint256 indexed projectId, uint256 indexed milestoneId);
    event Claimed(
        uint256 indexed projectId,
        address indexed client,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
        uint256[] milestoneIds,
        ProjectStatus projectStatus
    );
    event Stopped(
        address indexed client,
        uint256 indexed projectId,
        uint256 amount,
        address paymentToken,
        ProjectStatus projectStatus
    );
    event Judged(
        uint256 indexed projectId,
        uint256[] indexed milestoneIds,
        bool indexed isCancel,
        ProjectStatus projectStatus
    );
    event Toggled(bool isPaused);

    event SetServiceFeePercent(
        uint256 oldClientFeePercent,
        uint256 oldFreelancerFeePercent,
        uint256 newClientFeePercent,
        uint256 newFreelancerFeePercent
    );
    event SetPermittedToken(address indexed token, bool indexed allowed);
    event SetMaxMilestone(uint256 oldValue, uint256 newValue);

    modifier notZeroAddress(address _addr) {
        require(_addr != address(0), "Invalid address");
        _;
    }

    modifier onlyFreelancer(uint256 _projectId) {
        require(_msgSender() == projects[_projectId].freelancer, "Caller is not the freelancer of this project");
        _;
    }

    modifier onlyClient(uint256 _projectId) {
        require(_msgSender() == projects[_projectId].client, "Caller is not the Client of this project");
        _;
    }

    modifier onlyValidProject(uint256 _projectId) {
        require(_projectId > 0 && _projectId <= lastProjectId, "Invalid project id");
        require(projects[_projectId].status != ProjectStatus.STOPPED, "Project is stopped");
        _;
    }

    modifier onlyNonExpiredProject(uint256 _projectId) {
        require(block.timestamp <= projects[_projectId].expiredDate, "Project is expired");
        _;
    }

    /**
     *  @dev Initialize new contract.
     */
    function initialize(address _owner) public initializer {
        __Pausable_init();
        __Ownable_init();
        __ReentrancyGuard_init();

        transferOwnership(_owner);
        _pause();
    }

    // -----------External Functions-----------

    /**
     *  @dev    Toggle contract interupt
     *
     *  @notice Only owner can execute this function
     */
    function toggle() external onlyOwner {
        if (paused()) {
            _unpause();
        } else {
            _pause();
        }

        emit Toggled(paused());
    }

    /**
     *  @dev    Set permitted token for project
     *
     *  @notice Only Owner (KickstarService) can call this function.
     *
     *          Name            Meaning
     *  @param  _paymentToken    Address of token that needs to be permitted
     *  @param  _allowed         Allow or not to pay with this token
     *
     *  Emit event {SetPermittedToken}
     */
    function setPermittedToken(address _paymentToken, bool _allowed) external whenNotPaused onlyOwner {
        permittedPaymentTokens[_paymentToken] = _allowed;
        emit SetPermittedToken(_paymentToken, _allowed);
    }

    /**
     *  @dev    Set service fee percentage
     *
     *  @notice Only owner can call this function.
     *
     *          Name            Meaning
     *  @param  _clientFeePercent        		New client fee percent that want to be updated
     *  @param  _freelancerFeePercent        	New freelance fee percent that want to be updated
     *
     *  Emit event {SetServiceFeePercent}
     */
    function setServiceFeePercent(
        uint256 _clientFeePercent,
        uint256 _freelancerFeePercent
    ) external whenNotPaused onlyOwner {
        require(
            _clientFeePercent > 0 &&
                _freelancerFeePercent > 0 &&
                _clientFeePercent <= FEE_DENOMINATOR &&
                _freelancerFeePercent <= FEE_DENOMINATOR,
            "Invalid service fee percent"
        );

        uint256 oldClientFeePercent = clientFeePercent;
        uint256 oldFreelancerFeePercent = freelancerFeePercent;
        clientFeePercent = _clientFeePercent;
        freelancerFeePercent = _freelancerFeePercent;
        emit SetServiceFeePercent(oldClientFeePercent, oldFreelancerFeePercent, clientFeePercent, freelancerFeePercent);
    }

    /**
     * @notice Set max milestone
     *
     * @dev    Only owner or admin can call this function.
     *
     * @param  _maxMilestone   Number of milestone.
     *
     * emit {SetMaxMilestone} events
     */
    function setMaxMilestone(uint256 _maxMilestone) external whenNotPaused onlyOwner {
        require(_maxMilestone > 0, "Invalid maxMilestone");
        uint256 oldValue = maxMilestone;
        maxMilestone = _maxMilestone;
        emit SetMaxMilestone(oldValue, maxMilestone);
    }

    /**
     *  @dev    Create a new project
     *
     *  @notice Anyone can call this function.
     *
     *          Name                        Meaning
     *  @param  _freelancer                 Address of client
     *  @param  _paymentToken               Token contract address
     *  @param  _budget                     Total amount of project
     *  @param  _totalMilestone             Total milestone
     *  @param  _milestoneBudgets           Array of budget per installment of project
     *  @param  _expiredDate                Project's expired date
     *  @param  _payType                    Type of pay
     *
     *  Emit event {AcceptBid}
     */
    function acceptBid(
        address _freelancer,
        address _paymentToken,
        uint256 _budget,
        uint256 _expiredDate,
        uint256 _totalMilestone,
        uint256[] memory _milestoneBudgets,
        PayType _payType
    ) external payable whenNotPaused notZeroAddress(_freelancer) {
        require(_msgSender() != _freelancer, "Freelancer can not be same");
        require(permittedPaymentTokens[_paymentToken] == true || _paymentToken == address(0), "Invalid project token");
        require(_budget > 0, "Amount per installment must be greater than 0");
        require(
            _totalMilestone > 0 && _totalMilestone <= maxMilestone && _milestoneBudgets.length == _totalMilestone,
            "Invalid length"
        );

        uint256 currentTime = block.timestamp;
        require(_expiredDate > currentTime, "Invalid expired date");

        lastProjectId++;
        Project storage project = projects[lastProjectId];
        project.client = _msgSender();
        project.freelancer = _freelancer;
        project.paymentToken = _paymentToken;
        project.budget = _budget;
        project.totalMilestone = _totalMilestone;
        project.milestoneBudgets = _milestoneBudgets;
        project.createdDate = currentTime;
        project.expiredDate = _expiredDate;
        project.payType = _payType;
        project.clientFeePercent = clientFeePercent;
        project.freelancerFeePercent = freelancerFeePercent;

        uint256 _totalValue = 0;
        project.amountClientFee = calculateServiceFee(project.budget, clientFeePercent);

        for (uint256 i = 0; i < _milestoneBudgets.length; i++) {
            require(_milestoneBudgets[i] > 0, "Invalid amount of milestone");
            _totalValue += _milestoneBudgets[i];
        }
        require(_totalValue == _budget, "Invalid total amount");

        milestones[lastProjectId][0] = Milestone(lastProjectId, _milestoneBudgets[i], MilestoneStatus.PAID);

        if (_payType == PayType.ALL) {
            project.status = ProjectStatus.PAID;
            project.amountPaid = _budget;
        } else {
            project.amountPaid = _milestoneBudgets[0];
        }

        _deposit(project.paymentToken, _msgSender(), project.amountPaid + project.amountClientFee);

        emit AcceptBid(
            lastProjectId,
            _freelancer,
            _msgSender(),
            _paymentToken,
            _budget,
            currentTime,
            _expiredDate,
            project.status,
            _payType,
            _totalMilestone,
            _milestoneBudgets
        );
    }

    /**
     *  @dev    Client pay for the project
     *
     *  @notice Only Client can call this function.
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that needs to be updated
     *  @param  _milestoneIds       List milestone that needs to be paid
     *
     *  Emit event {Deposited}
     */
    function deposit(
        uint256 _projectId,
        uint256[] memory _milestoneIds
    )
        external
        payable
        whenNotPaused
        onlyValidProject(_projectId)
        onlyNonExpiredProject(_projectId)
        onlyClient(_projectId)
        nonReentrant
    {
        Project storage project = projects[_projectId];
        require(project.status != ProjectStatus.FINISHED, "Project is finished");

        uint256 _totalAmount = 0;
        for (uint256 i = 0; i < _milestoneIds.length; i++) {
            uint256 milestoneId = _milestoneIds[i];
            Milestone storage milestone = milestones[_projectId][milestoneId];
            require(milestone.projectId == _projectId, "Invalid milestone");
            require(milestone.status == MilestoneStatus.PENDING, "Milestone is not pending");

            _totalAmount += milestone.amount;
            milestone.status == MilestoneStatus.PAID;
        }

        if (_totalAmount > 0) {
            project.amountPaid += _totalAmount;
            _deposit(project.paymentToken, _msgSender(), _totalAmount);
        }

        emit Deposited(_projectId, _milestoneIds, _totalAmount, project.status);
    }

    /**
     *  @dev    Client cancels project according to "Right to Stop"
     *
     *  @notice Only Client can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that client want to cancel
     *
     *  Emit event {Stopped}
     */
    function stopProject(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyClient(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PAID, "Project has processed");

        project.status = ProjectStatus.STOPPED;
        uint256 _totalAmount = project.amountPaid + project.amountClientFee;

        if (project.amountPaid > 0) {
            _withdraw(project.client, project.paymentToken, _totalAmount);
        }

        emit Stopped(project.client, _projectId, _totalAmount, project.paymentToken, project.status);
    }

    /**
     *  @dev    Client confirm that provides service to Client
     *
     *  @notice Only Client can call this function.
     *
     *          Name        Meaning
     *  @param  _projectId  ID of project that needs to be updated
     *
     *  Emit event {ClientConfirmMilestone}
     */
    function clientConfirmMilestone(
        uint256 _projectId,
        uint256 _milestoneId,
        bool _isDepositNextMilestone
    )
        external
        payable
        whenNotPaused
        onlyValidProject(_projectId)
        onlyNonExpiredProject(_projectId)
        onlyClient(_projectId)
    {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project isn't processing");

        require(_milestoneId < project.lastMilestoneId, "Invalid milestoneId");
        Milestone storage milestone = milestones[_projectId][_milestoneId];
        require(
            milestone.status == MilestoneStatus.PAID,
            "This milestone has not been confirmed by freelancer"
        );
        milestone.status = MilestoneStatus.ACCEPTED;
        project.pendingMilestoneIds.push(_milestoneId);



        // pay type = half is only one milestone
        // check if type is all or milestone
        if (_milestoneId < project.lastMilestoneId - 1) {
            Milestone storage milestoneNext = milestones[_projectId][_milestoneId + 1];
            if (
                milestoneNext.projectId == _projectId &&
                milestoneNext.status == MilestoneStatus.PENDING &&
                _isDepositNextMilestone
            ) {
                uint256 _amountToPay = milestoneNext.amount;
                project.amountPaid += _amountToPay;
                milestoneNext.status = MilestoneStatus.PAID;
                _deposit(project.paymentToken, _msgSender(), _amountToPay);
            }
        }

        emit ClientConfirmMilestone(_projectId, _milestoneId, _isDepositNextMilestone);
    }

    /**
     *  @dev    Freelancer claim all milestones of project
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name          Meaning
     *  @param  _projectId    ID of project want to claim all milestones
     *
     *  Emit event {Claimed}
     */
    function claim(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyFreelancer(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        require(block.timestamp <= project.expiredDate, "Claim time has expired");
        require(project.pendingMilestoneIds.length > 0, "Nothing to claim");

        uint256 claimableTotalAmount = 0;
        // Set CLAIMED status for claimed milestone
        for (uint256 i = 0; i < project.pendingMilestoneIds.length; ++i) {
            uint256 milestoneId = project.pendingMilestoneIds[i];
            milestones[_projectId][milestoneId].status = MilestoneStatus.CLAIMED;
            claimableTotalAmount += milestones[_projectId][milestoneId].amount;
        }

        project.finishedMilestonesCount += project.pendingMilestoneIds.length;
        if (project.finishedMilestonesCount == project.lastMilestoneId) {
            project.status = ProjectStatus.FINISHED;
        }

        uint256[] memory pendingMilestoneIdsBefore = project.pendingMilestoneIds;
        project.pendingMilestoneIds = new uint256[](0);

        // Calculate fee and transfer tokens
        uint256 serviceFee = calculateServiceFee(claimableTotalAmount, project.freelancerFeePercent);
        uint256 claimableAmount = claimableTotalAmount - serviceFee;

        _withdraw(_msgSender(), project.paymentToken, claimableAmount);
        _withdraw(owner(), project.paymentToken, serviceFee);

        emit Claimed(
            _projectId,
            _msgSender(),
            project.paymentToken,
            claimableAmount,
            serviceFee,
            pendingMilestoneIdsBefore,
            project.status
        );
    }

    /**
     *  @dev    Judge for client and freelancer if they have conflict
     *
     *  @notice Only Owner (KickstarService) can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that Owner (KickstarService) want to handle
     *  @param  _milestoneIds       ID of milestones that want to judge
     *  @param  _isCancel           true -> Client win -> cancel this milestone; false -> Freelancer win -> force client to confirm this milestone
     *
     *  Emit event {Judged}
     */
    function judge(
        uint256 _projectId,
        bool _isStop
    ) external whenNotPaused onlyValidProject(_projectId) onlyOwner nonReentrant {
        require(_milestoneIds.length > 0, "Invalid milestone ids");

        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project hasn't been processing yet");

        Milestone storage milestone = milestones[_projectId][_milestoneId];
        require(milestone.status == MilestoneStatus.PAID, "Milestone hasn't confirm yet");

        if (_isStop) {
            milestone.status = MilestoneStatus.CANCELED;
            project.status == ProjectStatus.STOPPED;
            _withdraw(project.client, project.paymentToken, milestone.amount);
        } else {
            milestone.status = MilestoneStatus.ACCEPTED;
        }

        emit Judged(_projectId, _milestoneIds, _isStop, project.status);
    }

    /**
     *  @dev    Calculate service fee by amount project
     *
     *  @notice Service fee equal amount of project mutiply serviceFeePercent. The actual service fee will be divided by WEIGHT_DECIMAL and 100
     *
     *          Name                Meaning
     *  @param  _amount             Amount of service fee that want to withdraw
     *  @param  _serviceFeePercent  Service fee percent
     *
     *  @return Caculated service fee from the amount of token
     */
    function calculateServiceFee(uint256 _amount, uint256 _serviceFeePercent) public pure returns (uint256) {
        return (_amount * _serviceFeePercent) / FEE_DENOMINATOR;
    }

    /**
     *  @dev    Get pending milestone ids that waiting for Freelancer claim from project by project id
     *
     *          Name                Meaning
     *  @param  _projectId          Project id that milestone ids are belong to
     *
     *  @return Pending milestone ids that waiting for Freelancer claim
     */
    function getPendingMilestoneIds(uint256 _projectId) external view returns (uint256[] memory) {
        return projects[_projectId].pendingMilestoneIds;
    }

    /**
     *  @dev    Withdraw token from contract
     *
     *  @notice Transfer native coin or token to address
     *
     *          Name                Meaning
     *  @param  _receiver           Address of receiver
     *  @param  _paymentToken       Token address
     *  @param  _amount             Amount of native coin or token that want to transfer
     */
    function _withdraw(address _receiver, address _paymentToken, uint256 _amount) private {
        if (permittedPaymentTokens[_paymentToken]) {
            IERC20Upgradeable(_paymentToken).safeTransfer(_receiver, _amount);
        } else {
            Helper._transferNativeToken(_receiver, _amount);
        }
    }

    /**
     *  @dev    Deposit token from contract
     *
     *  @notice Transfer native coin or token to address
     *
     *          Name                Meaning
     *  @param  _paymentToken       Token address
     *  @param  _from               Address of sender
     *  @param  _amount             Amount of native coin or token that want to transfer
     */
    function _deposit(address _paymentToken, address _from, uint256 _amount) private {
        if (permittedPaymentTokens[_paymentToken]) {
            require(msg.value == 0, "Can only pay by token");
            IERC20Upgradeable(_paymentToken).safeTransferFrom(_from, address(this), _amount);
        } else {
            require(msg.value == _amount, "Invalid amount");
        }
    }
}
