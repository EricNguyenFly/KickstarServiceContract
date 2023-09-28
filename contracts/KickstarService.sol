// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/SignatureCheckerUpgradeable.sol";
import "./lib/Helper.sol";

contract KickstarService is PausableUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    //  prettier-ignore
    /*
     *  @dev Project struct
     */
    struct Project {
        address       freelancer;               // Freelancer of project
        address       client;                   // Client of project
        address       paymentToken;             // Project token using in Project
        uint256       budget;                   // Amount of all milestone
        uint256       amountPaid;               // The amount paid
        uint256       amountClaimable;          // The amount claimable
        uint256       amountCanceled;           // The amount canceled
        uint256       amountClientWithdrawable; // The amount client can withdraw of milestone canceled
        uint256       amountClientFee;          // The amount fee of client
        uint256       createdDate;              // Project's created day
        uint256       expiredDate;              // Project's expired day
        uint256       clientFeePercent;         // Client fee percent
		uint256       freelancerFeePercent;     // Freelancer fee percent
        ProjectStatus status;                   // Project's status
    }

    /**
     * @param signer - The address of the signer.
     * @param nonce - The nonce referred here is not the same as an Ethereum account's nonce.
     * @param expiry - Date when the signature expires
     * @param signature - The ECDSA signature of the borrower or the lender, obtained off-chain ahead of time, signing
     */
    struct Signature {
        uint256 nonce;
        uint256 expiry;
        address signer;
        bytes signature;
    }

    /**
     *  Status enum is status of a project
     *
     *          Suit                                              Value
     *           |                                                  |
     *  After Client create project                             REQUESTING
     *  When project is still in processing                     PROCESSING
     *  After the last milestone is completed                   FINISHED
     *  After Client stop project                               STOPPED
     *  Project has milestone canceled                          PARTIALLY_COMPLETED
     */
    enum ProjectStatus {
        REQUESTING,
        PROCESSING,
        FINISHED,
        STOPPED,
        PARTIALLY_COMPLETED
    }

    /**
     *  @notice address verify message of function clientConfirm
     */
    address public verifier;

    uint256 public constant FEE_DENOMINATOR = 10000;

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
     *  @dev Mapping project ID to milestone ID to check milestone has been paid yet
     */
    mapping(uint256 => mapping(uint256 => bool)) public isPaidMilestones;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => bool) public permittedPaymentTokens;

    /**
     *  @dev Mapping address of user to set feePercent per user
     */
    mapping(address => uint256) public feePercentOfAddress;

    event AcceptBid(
        uint256 indexed projectId,
        address freelancer,
        address client,
        address paymentToken,
        uint256 budget,
        uint256 createdDate,
        uint256 expiredDate,
        ProjectStatus status
    );
    event Deposited(uint256 indexed projectId, ProjectStatus projectStatus);
    event FreelancerAcceptProject(uint256 indexed projectId);
    event ClientConfirmed(uint256 indexed projectId, uint256 indexed milestoneId);
    event ConfirmedToRelease(uint256 indexed projectId, uint256 indexed milestoneId);
    event Claimed(
        uint256 indexed projectId,
        address indexed freelancer,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
        ProjectStatus projectStatus
    );
    event ClientWithdrawn(
        uint256 indexed projectId,
        address indexed client,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
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
    event SetFeePercentToAddress(address indexed addr, uint256 feePercent);
    event SetVerifier(address indexed oldValue, address indexed newValue);

    modifier notZeroAddress(address _account) {
        require(_account != address(0), "Invalid address");
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
    function initialize(address _owner, address _verifier) public initializer {
        __Pausable_init();
        __Ownable_init();
        __ReentrancyGuard_init();

        verifier = _verifier;

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
     *  @dev    Set service fee percentage to user
     *
     *  @notice Only Owner (KickstarService) can call this function.
     *
     *          Name            Meaning
     *  @param  _addr           Address of user that needs to change fee
     *  @param  _feePercent     New fee percent that want to be updated
     *
     *  Emit event {SetFeePercentToAddress}
     */
    function setFeePercentToAddress(
        address _addr,
        uint256 _feePercent
    ) external whenNotPaused onlyOwner notZeroAddress(_addr) {
        require(_feePercent > 0 && _feePercent <= FEE_DENOMINATOR, "Invalid feePercent");
        feePercentOfAddress[_addr] = _feePercent;
        emit SetFeePercentToAddress(_addr, _feePercent);
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
     * @notice Set address verify
     *
     * @dev    Only owner or admin can call this function.
     *
     * @param  _verifier   Address of verify message.
     *
     * emit {SetVerifier} events
     */
    function setVerifier(address _verifier) external onlyOwner notZeroAddress(_verifier) {
        require(_verifier != verifier, "Verifier already exists");

        address _oldValue = verifier;
        verifier = _verifier;
        emit SetVerifier(_oldValue, verifier);
    }

    /**
     *  @dev    Create a new project
     *
     *  @notice Anyone can call this function.
     *
     *          Name                    Meaning
     *  @param  _freelancer             Address of client
     *  @param  _paymentToken           Token contract address
     *  @param  _budget                 Total amount of project
     *  @param  _expiredDate            Project's expired date
     *
     *  Emit event {AcceptBid}
     */
    function acceptBid(
        address _freelancer,
        address _paymentToken,
        uint256 _budget,
        uint256 _expiredDate
    ) external payable whenNotPaused notZeroAddress(_freelancer) {
        require(_msgSender() != _freelancer, "Freelancer can not be same");
        require(permittedPaymentTokens[_paymentToken] || _paymentToken == address(0), "Invalid project token");
        require(_budget > 0, "Amount per installment must be greater than 0");

        uint256 currentTime = block.timestamp;
        require(_expiredDate > currentTime, "Invalid expired date");

        lastProjectId++;
        Project storage project = projects[lastProjectId];
        project.client = _msgSender();
        project.freelancer = _freelancer;
        project.paymentToken = _paymentToken;
        project.budget = _budget;
        project.createdDate = currentTime;
        project.expiredDate = _expiredDate;
        project.status = ProjectStatus.REQUESTING;
        project.clientFeePercent = feePercentOfAddress[_msgSender()] > 0
            ? feePercentOfAddress[_msgSender()]
            : clientFeePercent;
        project.freelancerFeePercent = feePercentOfAddress[_freelancer] > 0
            ? feePercentOfAddress[_freelancer]
            : freelancerFeePercent;

        project.amountClientFee = calculateServiceFee(project.budget, clientFeePercent);
        _deposit(project.paymentToken, _msgSender(), project.budget + project.amountClientFee);

        emit AcceptBid(
            lastProjectId,
            _freelancer,
            _msgSender(),
            _paymentToken,
            _budget,
            currentTime,
            _expiredDate,
            project.status
        );
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
        require(project.status == ProjectStatus.REQUESTING, "Project is not requesting");

        project.status = ProjectStatus.STOPPED;
        uint256 _totalAmount = project.budget + project.amountClientFee;

        if (_totalAmount > 0) {
            project.amountCanceled = _totalAmount;
            _withdraw(project.client, project.paymentToken, _totalAmount);
        }

        emit Stopped(project.client, _projectId, _totalAmount, project.paymentToken, project.status);
    }

    /**
     *  @dev    Freelancer accept that provides service of Client
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name        Meaning
     *  @param  _projectId  ID of project that needs to be updated
     *
     *  Emit event {FreelancerAcceptProject}
     */
    function freelancerAcceptProject(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyNonExpiredProject(_projectId) onlyFreelancer(_projectId) {
        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.REQUESTING, "Project is not requesting");
        project.status = ProjectStatus.PROCESSING;

        emit FreelancerAcceptProject(_projectId);
    }

    /**
     *  @dev    Client confirm that provides service to Client
     *
     *  @notice Only Client Owner can call this function.
     *
     *          Name                Meaning
     *  @param  _projectId          The id of project
     *  @param  _milestoneId        The id of milestone
     *  @param  _amount             Amount to freelancer can claim
     *  @param  _nonce              The nonce referred to here is not the same as an Ethereum account's nonce
     *  @param  _expiry             The date when the signature expires
     *  @param _signature           The ECDSA signature
     *
     *  Emit event {ClientConfirmed}
     */
    function clientConfirm(
        uint256 _projectId,
        uint256 _milestoneId,
        uint256 _amount,
        uint256 _nonce,
        uint256 _expiry,
        bytes memory _signature
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
        require(_amount > 0 && project.amountPaid + _amount <= project.budget, "Invalid amount");
        require(!isPaidMilestones[_projectId][_milestoneId], "Milestone has been paid");
        require(
            isValidSignature(
                _projectId,
                _milestoneId,
                _amount,
                Signature({ signer: verifier, nonce: _nonce, expiry: _expiry, signature: _signature })
            ),
            "Signature is invalid"
        );

        isPaidMilestones[_projectId][_milestoneId] = true;

        project.amountPaid += _amount;
        project.amountClaimable += _amount;

        _updateProject(project);

        emit ClientConfirmed(_projectId, _milestoneId);
    }

    /**
     *  @dev    Freelancer claim amount of project
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name          Meaning
     *  @param  _projectId    ID of project want to claim
     *
     *  Emit event {Claimed}
     */
    function claim(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyFreelancer(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        require(block.timestamp <= project.expiredDate, "Claim time has expired");
        require(project.amountClaimable > 0, "Nothing to claim");

        // Calculate fee and transfer tokens
        uint256 serviceFee = calculateServiceFee(project.amountClaimable, project.freelancerFeePercent);
        uint256 claimableAmount = project.amountClaimable - serviceFee;

        project.amountClaimable = 0;

        _withdraw(_msgSender(), project.paymentToken, claimableAmount);
        _withdraw(owner(), project.paymentToken, serviceFee);

        emit Claimed(_projectId, _msgSender(), project.paymentToken, claimableAmount, serviceFee, project.status);
    }

    /**
     *  @dev    Client withdraw amount canceled of project
     *
     *  @notice Only Client can call this function.
     *
     *          Name          Meaning
     *  @param  _projectId    ID of project want to withdraw
     *
     *  Emit event {ClientWithdrawn}
     */
    function clientWithdraw(
        uint256 _projectId
    ) external whenNotPaused onlyValidProject(_projectId) onlyClient(_projectId) nonReentrant {
        Project storage project = projects[_projectId];
        require(block.timestamp <= project.expiredDate, "Claim time has expired");
        require(project.amountClientWithdrawable > 0, "Nothing to withdraw");

        uint256 claimableAmount = project.amountClientWithdrawable;
        if (project.status == ProjectStatus.PARTIALLY_COMPLETED || project.status == ProjectStatus.STOPPED) {
            claimableAmount += project.amountClientFee;
        }

        project.amountClientWithdrawable = 0;

        _withdraw(_msgSender(), project.paymentToken, claimableAmount);

        emit ClientWithdrawn(_projectId, _msgSender(), project.paymentToken, claimableAmount, 0, project.status);
    }

    /**
     *  @dev    Return money for Client if Business Owner not provide services on time in a milestone
     *
     *  @notice Only Owner (KickstarService) can call this function
     *
     *          Name                Meaning
     *  @param  _projectId          ID of project that Owner (KickstarService) want to handle
     *  @param  _milestoneIds       ID of milestones that want to judge
     *  @param  _amounts            Amount of milestones that want to judge
     *  @param  _isCancel           true -> Client win -> cancel this milestone; false -> freelancer win -> force client to confirm this milestone
     *
     *  Emit event {Judged}
     */
    function judge(
        uint256 _projectId,
        uint256[] memory _milestoneIds,
        uint256[] memory _amounts,
        bool _isCancel
    ) external whenNotPaused onlyValidProject(_projectId) onlyOwner nonReentrant {
        require(_milestoneIds.length > 0, "Invalid milestone ids");

        Project storage project = projects[_projectId];
        require(project.status == ProjectStatus.PROCESSING, "Project hasn't been processing yet");

        for (uint256 i = 0; i < _milestoneIds.length; i++) {
            uint256 milestoneId = _milestoneIds[i];
            require(!isPaidMilestones[_projectId][milestoneId], "Milestone has been paid");

            isPaidMilestones[_projectId][milestoneId] = true;

            if (_isCancel) {
                project.amountCanceled += _amounts[i];
                project.amountClientWithdrawable += _amounts[i];
            } else {
                project.amountPaid += _amounts[i];
                project.amountClaimable += _amounts[i];
            }
        }

        _updateProject(project);

        emit Judged(_projectId, _milestoneIds, _isCancel, project.status);
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
     *  @dev    Get claimable amount of the freelancer's project
     *
     *          Name                Meaning
     *  @param  _projectId          Project id
     *
     */
    function getFreelancerClaimable(uint256 _projectId) external view returns (uint256) {
        return projects[_projectId].amountClaimable;
    }

    /**
     *  @dev    Get withdrawable amount of client's project
     *
     *          Name                Meaning
     *  @param  _projectId          Project id
     *
     */
    function getClientWithdrawable(uint256 _projectId) external view returns (uint256) {
        return projects[_projectId].amountClientWithdrawable;
    }

    /**
     * @dev This function gets the current chain ID.
     */
    function getChainID() public view returns (uint256) {
        uint256 id;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            id := chainid()
        }
        return id;
    }

    /**
     *  @dev    Check valid signature
     *
     *          Name               Meaning
     *  @param  _projectId         Project
     *  @param  _milestoneId       Milestone id
     *  @param  _amount            Amount of milestone
     *  @param  _signature         Signature to verify
     */
    function isValidSignature(
        uint256 _projectId,
        uint256 _milestoneId,
        uint256 _amount,
        Signature memory _signature
    ) public view returns (bool) {
        require(block.timestamp <= _signature.expiry, "Signature has expired");
        if (_signature.signer == address(0)) {
            return false;
        } else {
            bytes32 message = keccak256(
                abi.encodePacked(_projectId, _milestoneId, _amount, getEncodedSignature(_signature), getChainID())
            );

            return
                SignatureCheckerUpgradeable.isValidSignatureNow(
                    _signature.signer,
                    ECDSAUpgradeable.toEthSignedMessageHash(message),
                    _signature.signature
                );
        }
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

    function _updateProject(Project storage _project) private {
        if (_project.amountPaid == _project.budget) {
            _project.status = ProjectStatus.FINISHED;
            _withdraw(owner(), project.paymentToken, _project.amountClientFee);
        } else if (_project.amountCanceled == _project.budget) {
            _project.status = ProjectStatus.STOPPED;
        } else if (_project.amountCanceled + _project.amountPaid == _project.budget) {
            _project.status = ProjectStatus.PARTIALLY_COMPLETED;
        }
    }

    /**
     *  @dev    EncodePacked signature
     *
     *          Name               Meaning
     *  @param  _signature         Signature to verify
     */
    function getEncodedSignature(Signature memory _signature) internal pure returns (bytes memory) {
        return abi.encodePacked(_signature.signer, _signature.nonce, _signature.expiry);
    }
}
