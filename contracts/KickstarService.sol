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
     *  @dev Payment struct
     */
    struct Payment {
        address       freelancer;               // Freelancer of payment
        address       client;                   // Client of payment
        address       paymentToken;             // Payment token using in Payment
        PaymentStatus status;                   // Payment's status
        uint256       totalAmount;              // Amount of each phase
        uint256       finishedPhasesCount;  // Number of phases
        uint256       lastPhaseId;          // Last phase id
        uint256       createdDate;              // Payment's created day
        uint256       expiredDate;              // Payment's expired day
        uint256[]     pendingPhaseIds;      // List of phase ids of this phase
        uint256 clientFeePercent;
		uint256 freelancerFeePercent;
		bool       	  isMultiphase;             // Number of phases
    }

    //  prettier-ignore
    /*
     *  @dev Phase struct is information of phase includes: created date, paid date, status
     */
    struct Phase {
        uint256 expiredDate;                // Phase's active date
		uint256 amount;                // Phase's active date
        PhaseStatus status;               // Phase status
    }

    /**
     *  Status enum is status of a payment
     *
     *          Suit                                              Value
     *           |                                                  |
     *  After Business Owner requests payment                   REQUESTING
     *  After Client escrows money                              PAID
     *  When payment is still in processing                     CLAIMING
     *  After the last phase is completed                   FINISHED
     *  After Client cancels payment                            CANCELED
     */
    enum PaymentStatus {
        REQUESTING,
        PAID,
        PROCESSING,
        FINISHED,
        CANCELED
    }

    /**
     *  PhaseStatus enum is status of per phase
     *
     *          Suit                                                                        Value
     *           |                                                                             |
     *  Default phase status                                                            CREATED
     *  After Business provide service to Client                                            FREELANCER_CONFIRMED
     *  After Client confirm to release money                                               CLIENT_CONFIRMED
     *  After Business Owner claim phase                                                CLAIMED
     *  After Business Owner not provide service on time and fund is refunded to Client     CANCELED
     */
    enum PhaseStatus {
        PENDING,
        FREELANCER_CONFIRMED,
        CLIENT_CONFIRMED,
        CLAIMED,
        CANCELED
    }

    uint256 public constant FEE_DENOMINATOR = 10000;

    /**
     *  @dev serviceFee uint256 is service fee of each payment
     */
    uint256 public clientFeePercent;

    uint256 public freelancerFeePercent;

    /**
     *  @dev lastPaymentId uint256 is the latest requested payment ID started by 1
     */
    uint256 public lastPaymentId;

    /**
     *  @dev Mapping payment ID to a payment detail
     */
    mapping(uint256 => Payment) public payments;

    /**
     *  @dev Mapping payment ID to phase ID to get info of per phase
     */
    mapping(uint256 => mapping(uint256 => Phase)) public phases;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => bool) public permittedPaymentTokens;

    /**
     *  @dev Mapping address of token contract to permit to withdraw
     */
    mapping(address => uint256) public feePercentOfAddress;

    event AcceptBid(
        uint256 indexed paymentId,
        uint256 indexed phaseId,
        address freelancer,
        address client,
        address paymentToken,
        uint256 totalAmount,
        uint256 createdDate,
        uint256 expiredDate,
        PaymentStatus phaseStatus,
        bool isMultiphase
    );
    event Deposited(uint256 indexed paymentId, PaymentStatus paymentStatus);
    event ClientConfirmPhases(uint256 indexed paymentId, uint256[] phaseIds);
    event ConfirmedToRelease(uint256 indexed paymentId, uint256[] phaseIds);
    event Claimed(
        uint256 indexed paymentId,
        address indexed bo,
        address indexed paymentToken,
        uint256 amount,
        uint256 serviceFee,
        uint256[] phaseIds,
        PaymentStatus paymentStatus
    );
    event Canceled(
        address indexed bo,
        uint256 indexed paymentId,
        uint256 amount,
        address paymentToken,
        PaymentStatus paymentStatus
    );
    event Judged(
        uint256 indexed paymentId,
        uint256[] indexed phaseIds,
        bool indexed isCancel,
        PaymentStatus paymentStatus
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

    modifier onlyValidAddress(address _address) {
        uint32 size;
        assembly {
            size := extcodesize(_address)
        }
        require((size <= 0) && _address != address(0), "Invalid address");
        _;
    }

    modifier onlyFreelancer(uint256 _paymentId) {
        require(_msgSender() == payments[_paymentId].freelancer, "Caller is not the freelancer of this payment");
        _;
    }

    modifier onlyClient(uint256 _paymentId) {
        require(_msgSender() == payments[_paymentId].client, "Caller is not the Client of this payment");
        _;
    }

    modifier onlyValidPayment(uint256 _paymentId) {
        require(_paymentId > 0 && _paymentId <= lastPaymentId, "Invalid payment id");
        require(payments[_paymentId].status != PaymentStatus.CANCELED, "Payment is canceled");
        _;
    }

    modifier onlyRequestingPayment(uint256 _paymentId) {
        require(payments[_paymentId].status == PaymentStatus.REQUESTING, "Payment isn't requesting");
        _;
    }

    modifier onlyNonExpiredPayment(uint256 _paymentId) {
        require(block.timestamp <= payments[_paymentId].expiredDate, "Payment is expired");
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
     *  @dev    Set permitted token for payment
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

    function setFeePercentToAddress(address _addr, uint256 _feePercent) external whenNotPaused onlyOwner {
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
     *  @dev    Create a new payment
     *
     *  @notice Anyone can call this function.
     *
     *          Name                    Meaning
     *  @param  _freelancer                 Address of client
     *  @param  _paymentToken           Token contract address
     *  @param  _totalAmount                 Total amount of payment
     *  @param  _amountOfPhase    Array of amount per installment of payment
     *  @param  _expiredDateOfPhase    Array of expired per date installment of payment
     *  @param  _expiredDate            Payment's expired date
     *  @param  _isMultiphase            Multiphase
     *
     *  Emit event {AcceptBid}
     */
    function acceptBid(
        address _freelancer,
        address _paymentToken,
        uint256 _totalAmount,
        uint256 _expiredDate,
        uint256[] memory _amountOfPhase,
        uint256[] memory _expiredDateOfPhase,
        bool _isMultiphase
    ) external whenNotPaused {
        require(_msgSender() != _freelancer, "Freelancer can not be same");
        require(permittedPaymentTokens[_paymentToken] == true || _paymentToken == address(0), "Invalid payment token");
        require(_totalAmount > 0, "Amount per installment must be greater than 0");
        if (_isMultiphase) {
            require(_amountOfPhase.length > 0 && _amountOfPhase.length == _expiredDateOfPhase.length, "Invalid length");
        } else {
            require(
                _amountOfPhase.length == 1 && _amountOfPhase.length == _expiredDateOfPhase.length,
                "Job is not multiphase"
            );
        }

        uint256 currentTime = block.timestamp;
        require(_expiredDate > currentTime, "Invalid expired date");

        lastPaymentId++;
        Payment storage payment = payments[lastPaymentId];
        payment.client = _msgSender();
        payment.freelancer = _freelancer;
        payment.paymentToken = _paymentToken;
        payment.totalAmount = _totalAmount;
        payment.isMultiphase = _isMultiphase;
        payment.createdDate = currentTime;
        payment.expiredDate = _expiredDate;
        payment.clientFeePercent = feePercentOfAddress[_msgSender()] > 0
            ? feePercentOfAddress[_msgSender()]
            : clientFeePercent;
        payment.freelancerFeePercent = feePercentOfAddress[_freelancer] > 0
            ? feePercentOfAddress[_freelancer]
            : freelancerFeePercent;

        uint256 _totalValue = 0;
        for (uint256 i = 0; i < _amountOfPhase.length; i++) {
            payment.lastPhaseId++;
            require(_amountOfPhase[i] > 0, "Invalid amount of phase");
            require(_expiredDateOfPhase[i] > 0, "Invalid expired date of phase");
            if (i > 0) {
                require(
                    _expiredDateOfPhase[i] > _expiredDateOfPhase[i - 1],
                    "Expired date of phase after must be greater than before"
                );
            }
            _totalValue += _amountOfPhase[i];
            phases[lastPaymentId][payment.lastPhaseId] = Phase(
                _expiredDateOfPhase[i],
                _amountOfPhase[i],
                PhaseStatus.PENDING
            );
        }
        require(_totalValue == _totalAmount, "Invalid total amount");

        emit AcceptBid(
            lastPaymentId,
            payment.lastPhaseId,
            _freelancer,
            _msgSender(),
            _paymentToken,
            _totalAmount,
            currentTime,
            _expiredDate,
            payment.status,
            _isMultiphase
        );
    }

    /**
     *  @dev    Client cancels payment according to "Right to Cancel"
     *
     *  @notice Only Client can call this function
     *
     *          Name                Meaning
     *  @param  _paymentId          ID of payment that client want to cancel
     *
     *  Emit event {Canceled}
     */
    function cancelPayment(uint256 _paymentId) external whenNotPaused onlyValidPayment(_paymentId) nonReentrant {
        uint256 currentTime = block.timestamp;
        Payment storage payment = payments[_paymentId];

        require(
            payment.status == PaymentStatus.REQUESTING || payment.status == PaymentStatus.PAID,
            "Payment has processed"
        );
        require(currentTime <= payment.createdDate, "Can't cancel payment after cancelable duration");

        PaymentStatus paymentStatusBefore = payment.status;
        payment.status = PaymentStatus.CANCELED;

        if (paymentStatusBefore == PaymentStatus.PAID) {
            _withdraw(payment.client, payment.paymentToken, payment.totalAmount);
        }

        emit Canceled(payment.client, _paymentId, payment.totalAmount, payment.paymentToken, payment.status);
    }

    /**
     *  @dev    Client pay for the payment
     *
     *  @notice Only Client can call this function.
     *
     *          Name        Meaning
     *  @param  _paymentId  ID of payment that needs to be updated
     *  @param  _amount     Amount that needs to be paid
     *
     *  Emit event {Deposited}
     */
    function deposit(
        uint256 _paymentId,
        uint256 _amount
    )
        external
        payable
        whenNotPaused
        onlyValidPayment(_paymentId)
        onlyNonExpiredPayment(_paymentId)
        onlyRequestingPayment(_paymentId)
        onlyClient(_paymentId)
        nonReentrant
    {
        Payment storage payment = payments[_paymentId];
        require(_amount == payment.totalAmount, "Must pay enough total amount");

        payment.status = PaymentStatus.PAID;

        if (permittedPaymentTokens[payment.paymentToken]) {
            require(msg.value == 0, "Can only pay by token");
            IERC20Upgradeable(payment.paymentToken).safeTransferFrom(_msgSender(), address(this), _amount);
        } else {
            require(msg.value == _amount, "Invalid amount");
        }

        emit Deposited(_paymentId, payment.status);
    }

    /**
     *  @dev    Client confirm that provides service to Client
     *
     *  @notice Only Client Owner can call this function.
     *
     *          Name        Meaning
     *  @param  _paymentId  ID of payment that needs to be updated
     *
     *  Emit event {ClientConfirmPhases}
     */
    function clientConfirmPhases(
        uint256 _paymentId,
        uint256[] memory _phaseIds
    ) external whenNotPaused onlyValidPayment(_paymentId) onlyNonExpiredPayment(_paymentId) onlyClient(_paymentId) {
        Payment storage payment = payments[_paymentId];
        require(payment.status == PaymentStatus.PROCESSING, "Payment isn't processing");
        require(_phaseIds.length > 0, "Invalid phaseIds");

        for (uint256 i = 0; i < _phaseIds.length; i++) {
            require(_phaseIds[i] <= payment.lastPhaseId, "Invalid phaseId");
            Phase storage phase = phases[_paymentId][_phaseIds[i]];
            require(
                phase.status == PhaseStatus.FREELANCER_CONFIRMED,
                "This phase has not been confirmed by freelancer"
            );
            phase.status = PhaseStatus.CLIENT_CONFIRMED;
            payment.pendingPhaseIds.push(_phaseIds[i]);
        }

        emit ClientConfirmPhases(_paymentId, _phaseIds);
    }

    /**
     *  @dev    Freelancer confirm to release phase
     *
     *  @notice Only Freelancer can call this function.
     *
     *          Name          Meaning
     *  @param  _paymentId    ID of payment that needs to be confirmed
     *
     *  Emit event {ConfirmedToRelease}
     */
    function confirmToRelease(
        uint256 _paymentId,
        uint256[] memory _phaseIds
    ) external whenNotPaused onlyValidPayment(_paymentId) onlyNonExpiredPayment(_paymentId) onlyFreelancer(_paymentId) {
        Payment storage payment = payments[_paymentId];
        require(payment.status == PaymentStatus.PROCESSING, "Payment isn't processing");
        require(_phaseIds.length > 0, "Invalid phaseIds");

        for (uint256 i = 0; i < _phaseIds.length; i++) {
            require(_phaseIds[i] <= payment.lastPhaseId, "Invalid phaseId");
            Phase storage phase = phases[_paymentId][_phaseIds[i]];
            require(phase.status == PhaseStatus.PENDING, "Phase status is not pending");
            phase.status = PhaseStatus.FREELANCER_CONFIRMED;
        }

        emit ConfirmedToRelease(_paymentId, _phaseIds);
    }

    /**
     *  @dev    Business Owner claim all phases of payment
     *
     *  @notice Only Business Owner can call this function.
     *
     *          Name          Meaning
     *  @param  _paymentId    ID of payment want to claim all phases
     *
     *  Emit event {Claimed}
     */
    function claim(
        uint256 _paymentId
    ) external whenNotPaused onlyValidPayment(_paymentId) onlyFreelancer(_paymentId) nonReentrant {
        Payment storage payment = payments[_paymentId];
        require(block.timestamp <= payment.expiredDate, "Claim time has expired");
        require(payment.status == PaymentStatus.PROCESSING, "Payment hasn't been processing yet");
        require(payment.pendingPhaseIds.length > 0, "Nothing to claim");

        uint256 claimableTotalAmount = 0;
        // Set CLAIMED status for claimed phase
        for (uint256 i = 0; i < payment.pendingPhaseIds.length; ++i) {
            uint256 phaseId = payment.pendingPhaseIds[i];
            phases[_paymentId][phaseId].status = PhaseStatus.CLAIMED;
            claimableTotalAmount += phases[_paymentId][phaseId].amount;
        }

        payment.finishedPhasesCount += payment.pendingPhaseIds.length;
        if (payment.finishedPhasesCount == payment.lastPhaseId) {
            payment.status = PaymentStatus.FINISHED;
        }

        uint256[] memory pendingPhaseIdsBefore = payment.pendingPhaseIds;
        payment.pendingPhaseIds = new uint256[](0);

        // Calculate fee and transfer tokens
        uint256 serviceFee = calculateServiceFee(claimableTotalAmount, payment.freelancerFeePercent);
        uint256 claimableAmount = claimableTotalAmount - serviceFee;

        _withdraw(_msgSender(), payment.paymentToken, claimableAmount);
        _withdraw(owner(), payment.paymentToken, serviceFee);

        emit Claimed(
            _paymentId,
            _msgSender(),
            payment.paymentToken,
            claimableAmount,
            serviceFee,
            pendingPhaseIdsBefore,
            payment.status
        );
    }

    /**
     *  @dev    Return money for Client if Business Owner not provide services on time in a phase
     *
     *  @notice Only Owner (KickstarService) can call this function
     *
     *          Name                Meaning
     *  @param  _paymentId          ID of payment that Owner (KickstarService) want to handle
     *  @param  _phaseIds       ID of phases that want to judge
     *  @param  _isCancel           true -> Client win -> cancel this phase; false -> BO win -> force client to confirm this phase
     *
     *  Emit event {Judged}
     */
    function judge(
        uint256 _paymentId,
        uint256[] memory _phaseIds,
        bool _isCancel
    ) external whenNotPaused onlyValidPayment(_paymentId) onlyOwner nonReentrant {
        require(_phaseIds.length > 0, "Invalid phase ids");

        Payment storage payment = payments[_paymentId];
        require(payment.status == PaymentStatus.PROCESSING, "Payment hasn't been processing yet");

        for (uint256 i = 0; i < _phaseIds.length; i++) {
            uint256 phaseId = _phaseIds[i];
            Phase storage phase = phases[_paymentId][phaseId];
            require(phase.status == PhaseStatus.FREELANCER_CONFIRMED, "Phase hasn't confirm yet");

            if (_isCancel) {
                payment.finishedPhasesCount++;
                phase.status = PhaseStatus.CANCELED;
                _withdraw(payment.client, payment.paymentToken, phase.amount);
            } else {
                phase.status = PhaseStatus.CLIENT_CONFIRMED;
                payment.pendingPhaseIds.push(phaseId);
            }
        }

        emit Judged(_paymentId, _phaseIds, _isCancel, payment.status);
    }

    /**
     *  @dev    Calculate service fee by amount payment
     *
     *  @notice Service fee equal amount of payment mutiply serviceFeePercent. The actual service fee will be divided by WEIGHT_DECIMAL and 100
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
     *  @dev    Get pending phase ids that waiting for BO claim from payment by payment id
     *
     *          Name                Meaning
     *  @param  _paymentId          Payment id that phase ids are belong to
     *
     *  @return Pending phase ids that waiting for BO claim
     */
    function getPendingPhaseIds(uint256 _paymentId) external view returns (uint256[] memory) {
        return payments[_paymentId].pendingPhaseIds;
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
}
